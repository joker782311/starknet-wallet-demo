//this has question
import { Account, RpcProvider, ec, hash, CallData, constants } from 'starknet';

// Safe stringify that prints BigInt as hex
function safeStringify(obj) {
  return JSON.stringify(
      obj,
      (_, v) => (typeof v === 'bigint' ? '0x' + v.toString(16) : v),
      2
  );
}

// Convert various numeric inputs to hex string felt
function toHexNumberish(val) {
  if (val === null || val === undefined) return '0x0';
  if (typeof val === 'string') return val.startsWith('0x') ? val : '0x' + BigInt(val).toString(16);
  if (typeof val === 'number') return '0x' + BigInt(val).toString(16);
  if (typeof val === 'bigint') return '0x' + val.toString(16);
  const s = val?.toString?.();
  return s ? (s.startsWith('0x') ? s : '0x' + BigInt(s).toString(16)) : '0x0';
}

// Derive base URL from RPC URL
function deriveBaseFromRpcUrl(rpcUrl) {
  try {
    return String(rpcUrl).replace(/\/rpc\/[^/]+$/i, '');
  } catch (_) {
    return rpcUrl;
  }
}

// Compute DEPLOY_ACCOUNT hash compat (fallback when v3 object API is missing)
function computeDeployAccountTxHashCompat({
                                            contractAddress,
                                            classHash,
                                            constructorCalldata,
                                            salt,
                                            version,
                                            maxFee,
                                            chainId,
                                            nonce,
                                          }) {
  const fn1 = hash['computeDeployAccountTransactionHash'];
  const fn2 = hash['calculateDeployAccountTransactionHash'];
  if (typeof fn1 === 'function') {
    try {
      return fn1(contractAddress, classHash, constructorCalldata, salt, version, maxFee, chainId, nonce);
    } catch (_) {}
  }
  if (typeof fn2 === 'function') {
    try {
      return fn2(contractAddress, classHash, constructorCalldata, salt, version, maxFee, chainId, nonce);
    } catch (_) {}
  }
  const calldataHash = hash.computeHashOnElements(constructorCalldata);
  return hash.computeHashOnElements([
    constants.TransactionHashPrefix.DEPLOY_ACCOUNT,
    contractAddress,
    classHash,
    calldataHash,
    salt,
    version,
    maxFee,
    chainId,
    nonce,
  ]);
}

async function main() {
  // Basic config: reuse online working parameters (overridable via env)
  const RPC_URL = process.env.RPC_URL || 'rpc';
  const CHAIN_ID = process.env.CHAIN_ID || constants.StarknetChainId.SN_MAIN;
  const CLASS_HASH =
      process.env.CLASS_HASH || '';
  const PRIVATE_KEY =
      process.env.PRIVATE_KEY || '';

  // Intercept and log all requests/responses to RPC_URL
  let lastRpcRequest = null;
  let lastRpcResponse = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (url && url.startsWith(RPC_URL)) {
        let bodyObj = null;
        try {
          bodyObj = init?.body ? JSON.parse(init.body) : null;
        } catch (_) {}
        lastRpcRequest = { url, method: init?.method, headers: init?.headers, body: bodyObj ?? init?.body };
      }
    } catch (_) {}
    const res = await origFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : input?.url;
      const clone = res.clone();
      const text = await clone.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {}
      if (url && url.startsWith(RPC_URL)) {
        lastRpcResponse = json ?? text;
      }
    } catch (_) {}
    return res;
  };

  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const chainId = await provider.getChainId();
  console.info('RPC and chain info:', safeStringify({ RPC_URL, chainId }));

  // Generate keys and constructor params (owner + guardian, consistent with verified ABI)
  const starkKeyPub = ec.starkCurve.getStarkKey(PRIVATE_KEY);
  const constructorCalldata = CallData.compile({ owner: starkKeyPub, guardian: '0' });
  const constructorCalldataHex = Array.isArray(constructorCalldata)
      ? constructorCalldata.map((x) => toHexNumberish(x))
      : constructorCalldata;
  const addressSalt = starkKeyPub;
  const contractAddress = hash.calculateContractAddressFromHash(addressSalt, CLASS_HASH, constructorCalldata, 0);

  console.info('Offline prepared parameters:', safeStringify({
    classHash: CLASS_HASH,
    publicKey: starkKeyPub,
    addressSalt,
    contractAddress,
    constructorCalldata,
  }));

  // Estimate resource bounds and fee (to fill resource_bounds and tip); on-chain query before offline signing
  let feeEst = null;
  // Prefer Account's estimation method (verified non-zero resourceBounds in online version)
  try {
    const estimator = new Account({ provider, address: contractAddress, signer: PRIVATE_KEY });
    const est1 = estimator['estimateDeployAccountFee'];
    const est2 = estimator['estimateAccountDeployFee'];
    if (typeof est1 === 'function') {
      feeEst = await est1.call(estimator, {
        classHash: CLASS_HASH,
        constructorCalldata: constructorCalldataHex,
        addressSalt,
      });
    } else if (typeof est2 === 'function') {
      feeEst = await est2.call(estimator, {
        classHash: CLASS_HASH,
        constructorCalldata: constructorCalldataHex,
        addressSalt,
      });
    }
  } catch (e) {
    console.info('estimateDeployAccountFee failed:', e?.message || String(e));
  }
  // If still null, fall back to direct RPC estimation
  if (!feeEst) {
    try {
      const body = {
        jsonrpc: '2.0',
        id: 100,
        method: 'starknet_estimateFee',
        params: {
          request: [
            {
              type: 'DEPLOY_ACCOUNT',
              constructor_calldata: constructorCalldataHex,
              class_hash: CLASS_HASH,
              contract_address_salt: addressSalt,
              signature: [],
              nonce: '0x0',
              version: '0x100000000000000000000000000000003',
              resource_bounds: {
                l2_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
                l1_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
                l1_data_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
              },
              tip: '0x1',
              paymaster_data: [],
              nonce_data_availability_mode: 'L1',
              fee_data_availability_mode: 'L1',
            },
          ],
          block_id: 'latest',
          simulation_flags: ['SKIP_VALIDATE'],
        },
      };
      const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      feeEst = j?.result ?? j;
    } catch (e) {
      console.info('estimateFee RPC failed:', e?.message || String(e));
    }
  }
  console.info('Fee estimation result:', safeStringify(feeEst));

  // Extract resource_bounds and tip from estimation (convert to hex strings)
  const rb = feeEst?.resourceBounds || feeEst?.resource_bounds;
  const tipDec = feeEst?.suggestedTip || feeEst?.suggested_tip || 0;
  const resourceBoundsHex = rb
      ? {
        l2_gas: {
          max_amount: toHexNumberish(rb.l2_gas?.max_amount ?? 0),
          max_price_per_unit: toHexNumberish(rb.l2_gas?.max_price_per_unit ?? 0),
        },
        l1_gas: {
          max_amount: toHexNumberish(rb.l1_gas?.max_amount ?? 0),
          max_price_per_unit: toHexNumberish(rb.l1_gas?.max_price_per_unit ?? 0),
        },
        l1_data_gas: {
          max_amount: toHexNumberish(rb.l1_data_gas?.max_amount ?? 0),
          max_price_per_unit: toHexNumberish(rb.l1_data_gas?.max_price_per_unit ?? 0),
        },
      }
      : {
        l2_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
        l1_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
        l1_data_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
      };
  const tipHex = toHexNumberish(tipDec);

  // If estimation didn't return valid values, use typical resource upper bounds from previous successful logs as fallback
  const allZero =
      resourceBoundsHex.l2_gas.max_amount === '0x0' &&
      resourceBoundsHex.l2_gas.max_price_per_unit === '0x0' &&
      resourceBoundsHex.l1_gas.max_amount === '0x0' &&
      resourceBoundsHex.l1_gas.max_price_per_unit === '0x0' &&
      resourceBoundsHex.l1_data_gas.max_amount === '0x0' &&
      resourceBoundsHex.l1_data_gas.max_price_per_unit === '0x0';
  const resourceBoundsFinal = allZero
      ? {
        l2_gas: { max_amount: '0x118800', max_price_per_unit: '0x10c388d00' },
        l1_gas: { max_amount: '0x0', max_price_per_unit: '0x22c7dbdbe732' },
        l1_data_gas: { max_amount: '0x180', max_price_per_unit: '0x8148' },
      }
      : resourceBoundsHex;
  const tipFinal = tipHex === '0x0' ? '0x6c480' : tipHex;

  // Assemble v3 signing details (for library's v3 hash function)
  const v3SignerDetails = {
    contractAddress,
    constructorCalldata,
    salt: addressSalt,
    classHash: CLASS_HASH,
    version: '0x3',
    chainId: chainId,
    nonce: '0x0',
    // Important: DA modes use string enums, consistent with node-validated online version
    nonceDataAvailabilityMode: 'L1',
    feeDataAvailabilityMode: 'L1',
    resourceBounds: resourceBoundsFinal,
    tip: tipFinal,
    paymasterData: [],
  };

  // Compute message hash and sign with private key (offline)
  let msgHash;
  try {
    msgHash = hash.calculateDeployAccountTransactionHash(v3SignerDetails);
  } catch (_) {
    // Fallback to compatible hash (may omit v3 resource fields; node may strictly validate and fail, but still outputs full logs for comparison)
    msgHash = computeDeployAccountTxHashCompat({
      contractAddress,
      classHash: CLASS_HASH,
      constructorCalldata,
      salt: addressSalt,
      version: '0x3',
      maxFee: '0x0',
      chainId: chainId,
      nonce: '0x0',
    });
  }
  const sig = ec.starkCurve.sign(msgHash, PRIVATE_KEY);
  const signature = [toHexNumberish(sig.r), toHexNumberish(sig.s)];

  // Assemble offline-signed payload to broadcast (RPC v0.8 V3)
  const signedDeployPayload = {
    type: 'DEPLOY_ACCOUNT',
    contract_address_salt: addressSalt,
    class_hash: CLASS_HASH,
    constructor_calldata: constructorCalldataHex,
    version: '0x3',
    nonce: '0x0',
    signature: signature,
    resource_bounds: resourceBoundsFinal,
    tip: tipFinal,
    paymaster_data: [],
    nonce_data_availability_mode: 'L1',
    fee_data_availability_mode: 'L1',
  };

  console.info('Offline signing and broadcast data:', safeStringify({ v3SignerDetails, msgHash, signature, signedDeployPayload }));

  // Try broadcasting: prefer JSON-RPC (wrapped and array), then provider method and gateway
  let broadcastRes = null;
  let broadcastErr = null;
  let broadcastChannel = null;
  let broadcastRequest = null;
  try {
    // A) JSON-RPC wrapped form (consistent with online success log)
    const bodyWrapped = {
      jsonrpc: '2.0',
      id: 1,
      method: 'starknet_addDeployAccountTransaction',
      params: { deploy_account_transaction: signedDeployPayload },
    };
    broadcastChannel = 'jsonrpc.wrapped';
    broadcastRequest = { kind: 'jsonrpc', method: 'starknet_addDeployAccountTransaction', url: RPC_URL, body: bodyWrapped };
    let r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyWrapped) });
    let j = await r.json();
    if (j && j.error) throw new Error(safeStringify(j));
    broadcastRes = j.result ?? j;
  } catch (e) {
    broadcastErr = e;
    // B) JSON-RPC unwrapped array form
    try {
      const bodyArray = { jsonrpc: '2.0', id: 2, method: 'starknet_addDeployAccountTransaction', params: [signedDeployPayload] };
      broadcastChannel = 'jsonrpc.array';
      broadcastRequest = { kind: 'jsonrpc', method: 'starknet_addDeployAccountTransaction', url: RPC_URL, body: bodyArray };
      let r2 = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyArray) });
      let j2 = await r2.json();
      if (j2 && j2.error) throw new Error(safeStringify(j2));
      broadcastRes = j2.result ?? j2;
      broadcastErr = null;
    } catch (e2) {
      broadcastErr = e2;
    }
  }

  // C) Try gateway endpoint (if available)
  if (!broadcastRes) {
    try {
      const base = deriveBaseFromRpcUrl(RPC_URL);
      const gwUrl = base + '/gateway/add_transaction';
      const r = await fetch(gwUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signedDeployPayload),
      });
      const j = await r.json();
      broadcastChannel = 'gateway.add_transaction';
      broadcastRes = j?.result ?? j;
      broadcastErr = null;
    } catch (_) {}
  }

  // D) Try provider method (if available)
  if (!broadcastRes) {
    try {
      const addDeploy = provider['addDeployAccountTransaction'];
      if (typeof addDeploy === 'function') {
        broadcastChannel = 'provider.addDeployAccountTransaction';
        broadcastRequest = { kind: 'provider', method: 'addDeployAccountTransaction', body: signedDeployPayload };
        broadcastRes = await addDeploy.call(provider, signedDeployPayload);
        broadcastErr = null;
      }
    } catch (_) {}
  }

  console.info('Broadcast result:', safeStringify({ broadcastChannel, broadcastRequest, lastRpcRequest, lastRpcResponse, broadcastRes, broadcastErr }));

  const txHash = broadcastRes?.transaction_hash ?? broadcastRes?.transactionHash ?? null;
  if (txHash) {
    console.info('Transaction hash:', txHash);
    try {
      await provider.waitForTransaction(txHash);
      const receipt = await provider.getTransactionReceipt(txHash);
      console.info('Transaction receipt:', safeStringify(receipt));
    } catch (e) {
      console.info('Waiting for transaction / get receipt failed:', e?.message || String(e));
    }
  }

  // Restore fetch
  globalThis.fetch = origFetch;
}

main().catch((err) => {
  console.error('Run failed:', err?.message || String(err));
});

//error log
// "error": {
//   "code": 55,
//       "data": "StarknetError { code: KnownErrorCode(ValidateFailure), message: 'The 'validate' entry point panicked with: nError in contract (contract address: 0x0165e6f2c30a8d4e80d285ec8c8386c773e021b40d7c1fae941396ae83e1d6b4, class hash: 0x01a736d6ed154502257f02b1ccdf4d9d1089f80811cd6acad48e6b6a9d1f2003, selector: 0x036fcbf06cd96843058359e1a75928beacfac10727dab22a3972f0af8aa92895): n0x617267656e742f696e76616c69642d6f776e65722d736967 ('argent invalid owner sig'). n' }",
//       "message": "Account validation failed"
// },
// "id": 2,
//     "jsonrpc": "2.0"
// },
