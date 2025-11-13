//finally starknet v8.0 v9.0 offline sign
import {Account, RpcProvider, CallData, hash} from 'starknet';

function safeStringify(obj) {
  return JSON.stringify(
    obj,
    (_, v) => (typeof v === 'bigint' ? '0x' + v.toString(16) : v),
    2
  );
}

function toHexNumberish(val) {
  if (val === null || val === undefined) return '0x0';
  if (typeof val === 'string') return val.startsWith('0x') ? val : '0x' + BigInt(val).toString(16);
  if (typeof val === 'number') return '0x' + BigInt(val).toString(16);
  if (typeof val === 'bigint') return '0x' + val.toString(16);
  const s = val?.toString?.();
  return s ? (s.startsWith('0x') ? s : '0x' + BigInt(s).toString(16)) : '0x0';
}

function toBigIntNumberish(val) {
  if (val === null || val === undefined) return 0n;
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(val);
  if (typeof val === 'string') return val.startsWith('0x') ? BigInt(val) : BigInt(val);
  const s = val?.toString?.();
  return s ? (s.startsWith('0x') ? BigInt(s) : BigInt(s)) : 0n;
}

function toUint256(amount) {
  const big = toBigIntNumberish(amount);
  const low = big & ((1n << 128n) - 1n);
  const high = big >> 128n;
  return [toHexNumberish(low), toHexNumberish(high)];
}

function getChainContext(rpcUrl) {
  const provider = new RpcProvider({ nodeUrl: rpcUrl });
  const chainId = '0x534e5f4d41494e';
  return { provider, chainId };
}

// 通用：将 resource_bounds(hex 字符串) 转为签名需要的 BigInt 结构
function toSignResourceBounds(resourceBoundsFinal) {
  return {
    l2_gas: {
      max_amount: toBigIntNumberish(resourceBoundsFinal.l2_gas.max_amount),
      max_price_per_unit: toBigIntNumberish(resourceBoundsFinal.l2_gas.max_price_per_unit),
    },
    l1_gas: {
      max_amount: toBigIntNumberish(resourceBoundsFinal.l1_gas.max_amount),
      max_price_per_unit: toBigIntNumberish(resourceBoundsFinal.l1_gas.max_price_per_unit),
    },
    l1_data_gas: {
      max_amount: toBigIntNumberish(resourceBoundsFinal.l1_data_gas.max_amount),
      max_price_per_unit: toBigIntNumberish(resourceBoundsFinal.l1_data_gas.max_price_per_unit),
    },
  };
}

// 通用：提取签名数组并转为 hex（兼容 r/s 或直接数组返回）
function extractSignatureHex(signedLike) {
  const sigArrCandidate = signedLike?.signature || signedLike?.sig || signedLike;
  const sigArr = Array.isArray(sigArrCandidate)
    ? sigArrCandidate
    : (sigArrCandidate && typeof sigArrCandidate === 'object' && 'r' in sigArrCandidate && 's' in sigArrCandidate
        ? [sigArrCandidate.r, sigArrCandidate.s]
        : null);
  if (!sigArr || sigArr.length < 2) {
    throw new Error('库签名失败：未获取到有效 signature 数组');
  }
  return [toHexNumberish(sigArr[0]), toHexNumberish(sigArr[1])];
}

function compileCallsToExecuteCalldataHex(calls) {
  const orderCalls = calls.map((call) => ({
    contractAddress: call.contractAddress,
    entrypoint: call.entrypoint,
    calldata: Array.isArray(call.calldata) && '__compiled__' in call.calldata
      ? call.calldata
      : CallData.compile(call.calldata),
  }));
  const executeCalldata = CallData.compile({ orderCalls });
  return executeCalldata.map((x) => toHexNumberish(x));
}

// 合并：统一的离线交易构建器，支持 INVOKE 与 DEPLOY_ACCOUNT
async function buildOfflineTransaction({
  type = 'INVOKE',

  chainId: chainIdOverride,
  data = {},
} = {}) {
  const RPC_URL = "";
  const { provider, chainId: detectedChainId } = getChainContext(RPC_URL);
  const chainId = chainIdOverride || detectedChainId;
  console.info('RPC 与链信息:', safeStringify({ RPC_URL, chainId }));

  if (type === 'INVOKE') {
    const PRIVATE_KEY = data.privateKey || process.env.PRIVATE_KEY || '';
    const ACCOUNT_ADDRESS = data.accountAddress || '0x06da9178cdff06c892b346ac663dfcdaf6fe290338c1efa0290fa19868a58fc0';
    const TOKEN_ADDRESS = data.tokenAddress || '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
    const RECIPIENT = data.recipient || '0x07eaf9937cf1e165af6df70658385830798117b71483894fd84634d17a7c59ed';
    const AMOUNT = data.amount || process.env.AMOUNT || '10099680006825216';
    const nonceHex = data.nonceHex || '0x6';
    const paymasterData = data.paymasterData ?? [];
    const accountDeploymentData = data.accountDeploymentData ?? [];
    // 支持自定义 calls；否则按 TOKEN_ADDRESS/RECIPIENT/AMOUNT 构造
    let calls = data.calls;
    if (!calls) {
      if (!ACCOUNT_ADDRESS || !TOKEN_ADDRESS || !RECIPIENT) {
        throw new Error('请设置必需的参数或环境变量：ACCOUNT_ADDRESS、TOKEN_ADDRESS、RECIPIENT');
      }
      const [amountLow, amountHigh] = toUint256(AMOUNT);
      calls = [
        { contractAddress: TOKEN_ADDRESS, entrypoint: 'transfer', calldata: [RECIPIENT, amountLow, amountHigh] },
      ];
    }
    const executeCalldataHex = compileCallsToExecuteCalldataHex(calls);
    const resourceBoundsFinal = data.resourceBoundsFinal || {
      l2_gas: { max_amount: '0xbd6000', max_price_per_unit: '0x10c388d00' },
      l1_gas: { max_amount: '0x0', max_price_per_unit: '0x23e330694361' },
      l1_data_gas: { max_amount: '0x180', max_price_per_unit: '0x104497' },
    };
    const tipFinal = data.tipFinal || '0x1';
    const resourceBoundsForSign = toSignResourceBounds(resourceBoundsFinal);
    const tipForSign = toBigIntNumberish(tipFinal);
    const acc = new Account({ provider, address: ACCOUNT_ADDRESS, signer: PRIVATE_KEY });
    const signed = await acc.signer.signTransaction(calls, {
      walletAddress: ACCOUNT_ADDRESS,
      senderAddress: ACCOUNT_ADDRESS,
      version: '0x3',
      chainId,
      nonce: nonceHex,
      cairoVersion: '1',
      nonceDataAvailabilityMode: 'L1',
      feeDataAvailabilityMode: 'L1',
      resourceBounds: resourceBoundsForSign,
      tip: tipForSign,
      paymasterData,
      accountDeploymentData,
    });
    const signatureHex = extractSignatureHex(signed);
    const invokePayload = {
      type: 'INVOKE',
      sender_address: ACCOUNT_ADDRESS,
      calldata: executeCalldataHex,
      version: '0x3',
      nonce: nonceHex,
      signature: signatureHex,
      resource_bounds: resourceBoundsFinal,
      tip: tipFinal,
      paymaster_data: paymasterData,
      account_deployment_data: accountDeploymentData,
      nonce_data_availability_mode: 'L1',
      fee_data_availability_mode: 'L1',
    };
    const result = { invoke_transaction: invokePayload };
    console.info('离线签名与广播数据:', safeStringify(result));
    return result;
  }

  if (type === 'DEPLOY_ACCOUNT') {
    const PRIVATE_KEY = data.privateKey || process.env.PRIVATE_KEY || '';
    const CLASS_HASH = data.classHash || process.env.CLASS_HASH || '0x1a736d6ed154502257f02b1ccdf4d9d1089f80811cd6acad48e6b6a9d1f2003';
    const starkKeyPub = data.starkKeyPub || '0x9fef9fd59abe06ab8bd65a3cb751383794e64039dbe4360442793de6c0ef5c';
    const constructorObj = data.constructorObj || { owner: starkKeyPub, guardian: '0' };//公钥
    const constructorCalldataCompiled = data.constructorCalldata || CallData.compile(constructorObj);
    const constructorCalldataHex = Array.isArray(constructorCalldataCompiled)
      ? constructorCalldataCompiled.map((x) => toHexNumberish(x))
      : constructorCalldataCompiled;
    const addressSalt = data.addressSalt || starkKeyPub;
    const contractAddress = hash.calculateContractAddressFromHash(addressSalt, CLASS_HASH, constructorCalldataCompiled, 0);
    const resourceBoundsFinal = data.resourceBoundsFinal || {
      l2_gas: { max_amount: '0x1f2500', max_price_per_unit: '0x10c388d00' },
      l1_gas: { max_amount: '0x0', max_price_per_unit: '0x23e330694361' },
      l1_data_gas: { max_amount: '0x180', max_price_per_unit: '0x86c1' },
    };
    const tipFinal = data.tipFinal || '0x1';
    const resourceBoundsForSign = toSignResourceBounds(resourceBoundsFinal);
    const tipForSign = toBigIntNumberish(tipFinal);
    const nonceForSign = data.nonceHex || '0x0';
    const acc = new Account({ provider, address: contractAddress, signer: PRIVATE_KEY });
    const signed = await acc.signer.signDeployAccountTransaction({
      classHash: CLASS_HASH,
      contractAddress,
      constructorCalldata: constructorCalldataCompiled,
      addressSalt,
      version: '0x3',
      chainId,
      nonce: nonceForSign,
      nonceDataAvailabilityMode: 'L1',
      feeDataAvailabilityMode: 'L1',
      resourceBounds: resourceBoundsForSign,
      tip: tipForSign,
      paymasterData: [],
    });
    const sigHex = extractSignatureHex(signed);
    const payload = {
      type: 'DEPLOY_ACCOUNT',
      contract_address_salt: addressSalt,
      class_hash: CLASS_HASH,
      constructor_calldata: constructorCalldataHex,
      version: '0x3',
      nonce: nonceForSign,
      signature: sigHex,
      resource_bounds: resourceBoundsFinal,
      tip: tipFinal,
      paymaster_data: [],
      nonce_data_availability_mode: 'L1',
      fee_data_availability_mode: 'L1',
    };
    const result = { deploy_account_transaction: payload };
    console.info('离线签名与广播数据:', safeStringify(result));
    return result;
  }

  throw new Error(`未知的交易类型: ${type}`);
}

// 入口：通过传参调用统一构建方法，并按类型注入默认 data
async function buildOfflineTransactionEntry(params = {}) {
  const type = params.type || 'INVOKE';

  if (type === 'INVOKE') {
    const defaultData = {
      privateKey: process.env.PRIVATE_KEY || '',
      accountAddress: '0x06da9178cdff06c892b346ac663dfcdaf6fe290338c1efa0290fa19868a58fc0',
      tokenAddress: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
      recipient: '0x006b2f276666c719624594f931b119d40594849d6fde70e57a06b31f7bd6278f',
      amount: process.env.AMOUNT || '10099680006825216',
      nonceHex: '0x8',
      resourceBoundsFinal: {
        l2_gas: { max_amount: '0xbd6000', max_price_per_unit: '0x10c388d00' },
        l1_gas: { max_amount: '0x0', max_price_per_unit: '0x23e330694361' },
        l1_data_gas: { max_amount: '0x180', max_price_per_unit: '0x104497' },
      },
      tipFinal: '0x1',
      paymasterData: [],
      accountDeploymentData: [],
    };
    const merged = { ...defaultData, ...(params.data || {}) };
    return buildOfflineTransaction({ ...params, data: merged });
  }

  if (type === 'DEPLOY_ACCOUNT') {
    const defaultStarkKey = '';
    const defaultData = {
      privateKey: process.env.PRIVATE_KEY || '',
      classHash: process.env.CLASS_HASH || '0x1a736d6ed154502257f02b1ccdf4d9d1089f80811cd6acad48e6b6a9d1f2003',
      starkKeyPub: defaultStarkKey,
      // constructorObj 与 addressSalt 依赖 starkKeyPub，若未覆盖则在合并后自动补齐
      nonceHex: '0x0',
      resourceBoundsFinal: {
        l2_gas: { max_amount: '0x1f2500', max_price_per_unit: '0x10c388d00' },
        l1_gas: { max_amount: '0x0', max_price_per_unit: '0x23e330694361' },
        l1_data_gas: { max_amount: '0x180', max_price_per_unit: '0x86c1' },
      },
      tipFinal: '0x1',
    };
    const merged = { ...defaultData, ...(params.data || {}) };
    if (!merged.constructorObj) {
      merged.constructorObj = { owner: merged.starkKeyPub, guardian: '0' };
    }
    if (!merged.addressSalt) {
      merged.addressSalt = merged.starkKeyPub;
    }
    return buildOfflineTransaction({ ...params, data: merged });
  }

  return buildOfflineTransaction(params);
}

//

buildOfflineTransactionEntry({ type: 'DEPLOY_ACCOUNT' }).catch((err) => {
  console.error('运行失败:', err?.message || err);
  process.exitCode = 1;
});