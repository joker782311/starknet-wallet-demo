
//this is a success dem0
import { Account, RpcProvider, ec, hash, CallData } from 'starknet';

function safeStringify(obj) {
  return JSON.stringify(
    obj,
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    2
  );
}


async function main() {
  // 配置：可通过环境变量覆盖
  const RPC_URL = process.env.RPC_URL || 'rpc';
  const CLASS_HASH =
    process.env.CLASS_HASH || '';

  // 拦截并记录所有发往 RPC_URL 的请求和响应
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

  try {
    const provider = new RpcProvider({ nodeUrl: RPC_URL });
    const chainId = await provider.getChainId();
    console.info('RPC info:', safeStringify({ RPC_URL, chainId }));


    const privateKey = "0x18455cfa3e966a746248fc68dcc315d4ccc449ad3e12f53211848499e6c946a";
    const starkKeyPub = ec.starkCurve.getStarkKey(privateKey);
    // 兼容旧版账户（owner + guardian）构造参数
    const OZaccountConstructorCallData = CallData.compile({ owner: starkKeyPub, guardian: '0' });
    const address = hash.calculateContractAddressFromHash(starkKeyPub, CLASS_HASH, OZaccountConstructorCallData, 0);

    console.info(
      'params:',
      safeStringify({ privateKey, starkKeyPub, classHash: CLASS_HASH, constructorCalldata: OZaccountConstructorCallData, address })
    );

    // create online Account），use provider broadcast
    const account = new Account({ provider, address, signer: privateKey });



    // get fee
    const est1 = account['estimateDeployAccountFee'];
    const est2 = account['estimateAccountDeployFee'];
    let feeEst = null;
    if (typeof est1 === 'function') {
      try {
        feeEst = await est1.call(account, { classHash: CLASS_HASH, constructorCalldata: OZaccountConstructorCallData, addressSalt: starkKeyPub });
      } catch (e) {
        console.info('estimateDeployAccountFee error:', e?.message || String(e));
      }
    } else if (typeof est2 === 'function') {
      try {
        feeEst = await est2.call(account, { classHash: CLASS_HASH, constructorCalldata: OZaccountConstructorCallData, addressSalt: starkKeyPub });
      } catch (e) {
        console.info('estimateAccountDeployFee error:', e?.message || String(e));
      }
    }
    if (feeEst) {
      console.info('Cost estimates:', safeStringify(feeEst));
    }

    // deploy online
    let deployRes = null;
    try {
      const deployMethod = account['deployAccount'] ?? account['deploy'];
      if (typeof deployMethod !== 'function') throw new Error('Not supported deployAccount fun');
      deployRes = await deployMethod.call(account, {
        classHash: CLASS_HASH,
        constructorCalldata: OZaccountConstructorCallData,
        addressSalt: starkKeyPub,
      });
    } catch (e) {
      console.info('deploy error:', e?.message || String(e));
    }

    // 打印完整的请求与响应
    console.info(
      'JSON-RPC res and req: ',
      safeStringify({ lastRpcRequest, lastRpcResponse, deployRes })
    );

    // get hash
    const txHash = deployRes?.transaction_hash ?? deployRes?.transactionHash ?? null;
    if (txHash) {
      console.info('hash:', txHash);
      try {
        await provider.waitForTransaction(txHash);
        const receipt = await provider.getTransactionReceipt(txHash);
        console.info('receipt:', safeStringify(receipt));
      } catch (e) {
        console.info('get receipt error:', e?.message || String(e));
      }
    }
  } finally {
    // fetch
    globalThis.fetch = origFetch;
  }
}

main().catch((err) => {
  console.error('run error:', err?.message || String(err));
});