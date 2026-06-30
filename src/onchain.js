const {
  BASE_CHAIN_ID,
  BASE_CHAIN_ID_HEX,
  BASE_CHAIN_PARAMS,
  LIQUID_SPLIT_FACTORY_ADDRESS,
  TEMP_BONDING_CURVE_ADDRESS,
  ZERO_DISTRIBUTOR_FEE,
  buildLiquidSplitAllocations,
} = require('./liquid-split-core');

const { decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData, getAddress, zeroAddress } = require('viem');

const LIQUID_SPLIT_FACTORY_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'contract LS1155CloneImpl', name: 'ls', type: 'address' },
    ],
    name: 'CreateLS1155Clone',
    type: 'event',
  },
  {
    inputs: [
      { internalType: 'address[]', name: 'accounts', type: 'address[]' },
      { internalType: 'uint32[]', name: 'initAllocations', type: 'uint32[]' },
      { internalType: 'uint32', name: '_distributorFee', type: 'uint32' },
      { internalType: 'address', name: 'owner', type: 'address' },
    ],
    name: 'createLiquidSplitClone',
    outputs: [{ internalType: 'contract LS1155CloneImpl', name: 'ls', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];
const LS1155_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'operator', type: 'address' },
      { indexed: true, internalType: 'address', name: 'from', type: 'address' },
      { indexed: true, internalType: 'address', name: 'to', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'id', type: 'uint256' },
      { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'TransferSingle',
    type: 'event',
  },
  {
    inputs: [
      { internalType: 'address', name: '', type: 'address' },
      { internalType: 'uint256', name: '', type: 'uint256' },
    ],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

function normalizeChainId(chainId) {
  if (typeof chainId === 'number') return chainId;
  if (typeof chainId === 'string' && chainId.startsWith('0x')) return parseInt(chainId, 16);
  return Number(chainId);
}

async function ensureBase(provider) {
  const current = await provider.request({ method: 'eth_chainId' });
  if (normalizeChainId(current) === BASE_CHAIN_ID) return;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BASE_CHAIN_ID_HEX }],
    });
  } catch (err) {
    if (err && err.code === 4902) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [BASE_CHAIN_PARAMS],
      });
      // Some wallets add a chain without selecting it, so switch again explicitly.
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: BASE_CHAIN_ID_HEX }],
      });
      return;
    }
    throw err;
  }
}

async function waitForReceipt(provider, txHash, options = {}) {
  const timeoutMs = options.timeoutMs || 120000;
  const pollMs = options.pollMs || 1500;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  throw new Error('Timed out waiting for Liquid Split transaction receipt.');
}

function decodeLiquidSplitAddress(receipt) {
  const logs = receipt && receipt.logs ? receipt.logs : [];
  for (const log of logs) {
    if (String(log.address || '').toLowerCase() !== LIQUID_SPLIT_FACTORY_ADDRESS.toLowerCase()) continue;
    try {
      // The factory return value is not available from eth_sendTransaction; the
      // explorer and SDK use this event as the durable source of the clone address.
      const event = decodeEventLog({
        abi: LIQUID_SPLIT_FACTORY_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (event.eventName === 'CreateLS1155Clone' && event.args && event.args.ls) {
        return getAddress(event.args.ls);
      }
    } catch (err) {}
  }
  throw new Error('Liquid Split creation event was not found in the transaction receipt.');
}

async function rpcCall(method, params, rpcUrl) {
  const res = await fetch(rpcUrl || BASE_CHAIN_PARAMS.rpcUrls[0], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'Base RPC request failed.');
  return body.result;
}

async function getLiquidSplitTokenBalance(options) {
  const liquidSplitAddress = getAddress(options && options.liquidSplitAddress);
  const account = getAddress(options && options.account);
  const tokenId = BigInt(options && options.tokenId != null ? options.tokenId : 0);
  const data = encodeFunctionData({
    abi: LS1155_ABI,
    functionName: 'balanceOf',
    args: [account, tokenId],
  });
  const result = await rpcCall('eth_call', [{ to: liquidSplitAddress, data }, 'latest'], options && options.rpcUrl);
  return decodeFunctionResult({
    abi: LS1155_ABI,
    functionName: 'balanceOf',
    data: result,
  });
}

function decodeTransferSingleAmount(data) {
  const id = BigInt('0x' + data.slice(2, 66));
  const amount = BigInt('0x' + data.slice(66, 130));
  return { id, amount };
}

function topicAddress(topic) {
  return getAddress('0x' + topic.slice(-40));
}

async function getTransactionBlockNumber(txHash, rpcUrl) {
  if (!txHash) return null;
  const receipt = await rpcCall('eth_getTransactionReceipt', [txHash], rpcUrl);
  return receipt && receipt.blockNumber ? receipt.blockNumber : null;
}

async function getLiquidSplitHolders(options) {
  const liquidSplitAddress = getAddress(options && options.liquidSplitAddress);
  const tokenId = BigInt(options && options.tokenId != null ? options.tokenId : 0);
  const fromBlock = (options && options.fromBlock)
    || await getTransactionBlockNumber(options && options.deploymentTxHash, options && options.rpcUrl)
    || '0x0';
  const transferTopic = encodeEventTopics({
    abi: LS1155_ABI,
    eventName: 'TransferSingle',
  })[0];
  const logs = await rpcCall('eth_getLogs', [{
    address: liquidSplitAddress,
    fromBlock,
    toBlock: 'latest',
    topics: [transferTopic],
  }], options && options.rpcUrl);
  const addresses = new Set();
  for (const log of logs || []) {
    if (!log.data || log.data.length < 130 || !log.topics || log.topics.length < 4) continue;
    const decoded = decodeTransferSingleAmount(log.data);
    if (decoded.id !== tokenId || decoded.amount === 0n) continue;
    const from = topicAddress(log.topics[2]);
    const to = topicAddress(log.topics[3]);
    if (from.toLowerCase() !== zeroAddress.toLowerCase()) addresses.add(from);
    if (to.toLowerCase() !== zeroAddress.toLowerCase()) addresses.add(to);
  }
  const holders = [];
  for (const address of Array.from(addresses).sort((a, b) => a.toLowerCase() > b.toLowerCase() ? 1 : -1)) {
    const balance = await getLiquidSplitTokenBalance({
      liquidSplitAddress,
      account: address,
      tokenId,
      rpcUrl: options && options.rpcUrl,
    });
    if (balance > 0n) holders.push({ address, balance: Number(balance) });
  }
  return holders;
}

async function deployLiquidSplit(options) {
  const provider = options && options.provider;
  const issuance = options && options.issuance;
  const owner = options && options.owner;
  if (!provider) throw new Error('Wallet provider is required.');
  if (!owner) throw new Error('Connected wallet is required.');

  await ensureBase(provider);
  const normalizedOwner = getAddress(owner);
  const { accounts, initAllocations } = buildLiquidSplitAllocations(issuance, { getAddress });
  const data = encodeFunctionData({
    abi: LIQUID_SPLIT_FACTORY_ABI,
    functionName: 'createLiquidSplitClone',
    args: [accounts, initAllocations, ZERO_DISTRIBUTOR_FEE, normalizedOwner],
  });

  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from: normalizedOwner,
      to: LIQUID_SPLIT_FACTORY_ADDRESS,
      data,
      chainId: BASE_CHAIN_ID_HEX,
    }],
  });
  const receipt = await waitForReceipt(provider, txHash, options);
  if (receipt.status && normalizeChainId(receipt.status) === 0) {
    throw new Error('Liquid Split transaction reverted.');
  }
  return {
    chainId: BASE_CHAIN_ID,
    factoryAddress: LIQUID_SPLIT_FACTORY_ADDRESS,
    transactionHash: txHash,
    liquidSplitAddress: decodeLiquidSplitAddress(receipt),
    accounts,
    initAllocations,
  };
}

window.PactLiquidSplit = {
  BASE_CHAIN_ID,
  BASE_CHAIN_ID_HEX,
  LIQUID_SPLIT_FACTORY_ADDRESS,
  TEMP_BONDING_CURVE_ADDRESS,
  buildLiquidSplitAllocations: issuance => buildLiquidSplitAllocations(issuance, { getAddress }),
  deployLiquidSplit,
  getLiquidSplitTokenBalance,
  getLiquidSplitHolders,
};
