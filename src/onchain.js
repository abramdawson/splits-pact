const {
  BASE_CHAIN_ID,
  BASE_CHAIN_ID_HEX,
  BASE_CHAIN_PARAMS,
  BASE_USDC_ADDRESS,
  LIQUID_SPLIT_FACTORY_ADDRESS,
  TEMP_BONDING_CURVE_ADDRESS,
  ZERO_DISTRIBUTOR_FEE,
  buildLiquidSplitAllocations,
  buildOfferingFactoryInputs,
  deriveOfferingCurve,
  toUsdcBaseUnits,
} = require('./liquid-split-core');
const {
  OFFERING_FACTORY_ADDRESS,
  OFFERING_FACTORY_ABI,
  OFFERING_ABI,
} = require('./generated/offering-contracts');

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
const ERC20_ABI = [
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
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

function decodeOfferingCreated(receipt, factoryAddress) {
  const normalizedFactory = getAddress(factoryAddress);
  for (const log of (receipt && receipt.logs) || []) {
    if (String(log.address || '').toLowerCase() !== normalizedFactory.toLowerCase()) continue;
    try {
      const event = decodeEventLog({
        abi: OFFERING_FACTORY_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (event.eventName === 'OfferingCreated' && event.args) {
        return {
          offeringAddress: getAddress(event.args.offering),
          liquidSplitAddress: getAddress(event.args.liquidSplit),
          paymentToken: getAddress(event.args.paymentToken),
          raiseMin: Number(event.args.raiseMin),
          closeDate: Number(event.args.closeDate),
          priceStart: Number(event.args.priceStart),
          priceSlope: Number(event.args.priceSlope),
        };
      }
    } catch (err) {}
  }
  throw new Error('Offering creation event was not found in the transaction receipt.');
}

async function rpcCall(method, params, rpcUrl, provider) {
  if (provider && !rpcUrl) {
    return provider.request({ method, params });
  }
  const res = await fetch(rpcUrl || BASE_CHAIN_PARAMS.rpcUrls[0], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'Base RPC request failed.');
  return body.result;
}

async function readContract({ address, abi, functionName, args, rpcUrl, provider }) {
  const data = encodeFunctionData({ abi, functionName, args });
  const result = await rpcCall('eth_call', [{ to: getAddress(address), data }, 'latest'], rpcUrl, provider);
  return decodeFunctionResult({ abi, functionName, data: result });
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
  const result = await rpcCall('eth_call', [{ to: liquidSplitAddress, data }, 'latest'], options && options.rpcUrl, options && options.provider);
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

async function getOfferingPurchaseFromTx(options) {
  const txHash = options && options.txHash;
  if (!txHash) throw new Error('Purchase transaction hash is required.');
  const receipt = await rpcCall('eth_getTransactionReceipt', [txHash], options && options.rpcUrl, options && options.provider);
  if (!receipt) throw new Error('Purchase transaction receipt was not found.');
  return getOfferingPurchaseFromReceipt({
    receipt,
    offeringAddress: options && options.offeringAddress,
    buyer: options && options.buyer,
  });
}

async function getOfferingPurchaseFromReceipt(options) {
  const receipt = options && options.receipt;
  const offeringAddress = getAddress(options && options.offeringAddress);
  const buyer = options && options.buyer ? getAddress(options.buyer) : null;
  for (const log of receipt.logs || []) {
    if (String(log.address || '').toLowerCase() !== offeringAddress.toLowerCase()) continue;
    try {
      const event = decodeEventLog({
        abi: OFFERING_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (event.eventName !== 'Bought' || !event.args) continue;
      if (buyer && String(event.args.buyer || '').toLowerCase() !== buyer.toLowerCase()) continue;
      return {
        buyer: getAddress(event.args.buyer),
        units: Number(event.args.units),
        cost: Number(event.args.cost),
      };
    } catch (err) {}
  }
  throw new Error('Purchase event was not found in the transaction receipt.');
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

async function createOffering(options) {
  const provider = options && options.provider;
  const issuance = options && options.issuance;
  const owner = options && options.owner;
  const factoryAddress = options && options.factoryAddress
    || (typeof globalThis !== 'undefined' && globalThis.PACT_OFFERING_FACTORY_ADDRESS)
    || OFFERING_FACTORY_ADDRESS;
  if (!provider) throw new Error('Wallet provider is required.');
  if (!owner) throw new Error('Connected wallet is required.');
  if (!factoryAddress) throw new Error('Offering factory has not been deployed yet.');

  await ensureBase(provider);
  const normalizedOwner = getAddress(owner);
  const treasury = getAddress(issuance.proceedsAddress);
  const closeDate = Math.floor(Date.now() / 1000) + Number(issuance.minimum.deadlineDays) * 86400;
  const curve = deriveOfferingCurve(issuance);
  const inputs = buildOfferingFactoryInputs(issuance, { getAddress });
  const data = encodeFunctionData({
    abi: OFFERING_FACTORY_ABI,
    functionName: 'createOffering',
    args: [
      BASE_USDC_ADDRESS,
      BigInt(toUsdcBaseUnits(issuance.raise.min)),
      BigInt(closeDate),
      BigInt(curve.priceStart),
      BigInt(curve.priceSlope),
      treasury,
      inputs.holderAccounts,
      inputs.holderAllocations,
      inputs.offeringUnits,
    ],
  });

  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from: normalizedOwner,
      to: getAddress(factoryAddress),
      data,
      chainId: BASE_CHAIN_ID_HEX,
    }],
  });
  const receipt = await waitForReceipt(provider, txHash, options);
  if (receipt.status && normalizeChainId(receipt.status) === 0) {
    throw new Error('Offering creation transaction reverted.');
  }
  const created = decodeOfferingCreated(receipt, factoryAddress);
  return {
    chainId: BASE_CHAIN_ID,
    factoryAddress: getAddress(factoryAddress),
    transactionHash: txHash,
    closeDate,
    curve,
    holderAccounts: inputs.holderAccounts,
    holderAllocations: inputs.holderAllocations,
    offeringUnits: inputs.offeringUnits,
    ...created,
  };
}

async function getOfferingState(options) {
  const offeringAddress = getAddress(options && options.offeringAddress);
  const buyer = options && options.buyer ? getAddress(options.buyer) : null;
  const reads = [
    readContract({ address: offeringAddress, abi: OFFERING_ABI, functionName: 'remainingUnits', args: [], rpcUrl: options && options.rpcUrl, provider: options && options.provider }),
    readContract({ address: offeringAddress, abi: OFFERING_ABI, functionName: 'unitsSold', args: [], rpcUrl: options && options.rpcUrl, provider: options && options.provider }),
    readContract({ address: offeringAddress, abi: OFFERING_ABI, functionName: 'minMet', args: [], rpcUrl: options && options.rpcUrl, provider: options && options.provider }),
    readContract({ address: offeringAddress, abi: OFFERING_ABI, functionName: 'state', args: [], rpcUrl: options && options.rpcUrl, provider: options && options.provider }),
    readContract({ address: offeringAddress, abi: OFFERING_ABI, functionName: 'raised', args: [], rpcUrl: options && options.rpcUrl, provider: options && options.provider }),
    readContract({ address: offeringAddress, abi: OFFERING_ABI, functionName: 'withdrawn', args: [], rpcUrl: options && options.rpcUrl, provider: options && options.provider }),
    readContract({ address: offeringAddress, abi: OFFERING_ABI, functionName: 'raiseMin', args: [], rpcUrl: options && options.rpcUrl, provider: options && options.provider }),
    readContract({ address: offeringAddress, abi: OFFERING_ABI, functionName: 'closeDate', args: [], rpcUrl: options && options.rpcUrl, provider: options && options.provider }),
    readContract({ address: offeringAddress, abi: OFFERING_ABI, functionName: 'owner', args: [], rpcUrl: options && options.rpcUrl, provider: options && options.provider }),
    readContract({ address: offeringAddress, abi: OFFERING_ABI, functionName: 'treasury', args: [], rpcUrl: options && options.rpcUrl, provider: options && options.provider }),
  ];
  if (buyer) reads.push(readContract({ address: offeringAddress, abi: OFFERING_ABI, functionName: 'deposits', args: [buyer], rpcUrl: options && options.rpcUrl, provider: options && options.provider }));
  const [remainingUnits, unitsSold, minMet, state, raised, withdrawn, raiseMin, closeDate, owner, treasury, deposit] = await Promise.all(reads);
  const result = {
    remainingUnits: Number(remainingUnits),
    unitsSold: Number(unitsSold),
    minMet,
    state: Number(state),
    raised: Number(raised),
    withdrawn: Number(withdrawn),
    raiseMin: Number(raiseMin),
    closeDate: Number(closeDate),
    owner: getAddress(owner),
    treasury: getAddress(treasury),
  };
  if (buyer) result.deposit = Number(deposit);
  return result;
}

async function sendOfferingFunction(options) {
  const provider = options && options.provider;
  const from = options && options.from;
  const offeringAddress = getAddress(options && options.offeringAddress);
  const functionName = options && options.functionName;
  const args = (options && options.args) || [];
  if (!provider) throw new Error('Wallet provider is required.');
  if (!from) throw new Error('Connected wallet is required.');
  await ensureBase(provider);
  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from: getAddress(from),
      to: offeringAddress,
      data: encodeFunctionData({ abi: OFFERING_ABI, functionName, args }),
      chainId: BASE_CHAIN_ID_HEX,
    }],
  });
  const receipt = await waitForReceipt(provider, txHash, options);
  if (receipt.status && normalizeChainId(receipt.status) === 0) throw new Error('Offering transaction reverted.');
  return { txHash, receipt };
}

function withdrawOffering(options) {
  return sendOfferingFunction({ ...(options || {}), functionName: 'withdraw' });
}

function closeAndWithdrawOffering(options) {
  return sendOfferingFunction({ ...(options || {}), functionName: 'closeAndWithdraw' });
}

function markOfferingFailed(options) {
  return sendOfferingFunction({ ...(options || {}), functionName: 'markFailed' });
}

function refundOffering(options) {
  return sendOfferingFunction({ ...(options || {}), functionName: 'refund' });
}

async function getOfferingPurchaseState(options) {
  const offeringAddress = getAddress(options && options.offeringAddress);
  const remainingUnits = await readContract({
    address: offeringAddress,
    abi: OFFERING_ABI,
    functionName: 'remainingUnits',
    args: [],
    rpcUrl: options && options.rpcUrl,
    provider: options && options.provider,
  });
  const unitsSold = await readContract({
    address: offeringAddress,
    abi: OFFERING_ABI,
    functionName: 'unitsSold',
    args: [],
    rpcUrl: options && options.rpcUrl,
    provider: options && options.provider,
  });
  return {
    remainingUnits: Number(remainingUnits),
    unitsSold: Number(unitsSold),
  };
}

function localCostFor(curve, sold, units) {
  if (!units) return 0;
  return units * curve.priceStart + curve.priceSlope * (sold * units + (units * (units - 1)) / 2);
}

async function quoteOfferingPurchase(options) {
  const issuance = options && options.issuance;
  const amountUsd = Number(options && options.amountUsd);
  if (!issuance || !issuance.offeringAddress) throw new Error('Offering contract is not available.');
  const state = await getOfferingPurchaseState({
    offeringAddress: issuance.offeringAddress,
    rpcUrl: options && options.rpcUrl,
    provider: options && options.provider,
  });
  const curve = issuance.curveParams || deriveOfferingCurve(issuance);
  const budget = toUsdcBaseUnits(amountUsd);
  let units = 0;
  for (let candidate = 1; candidate <= state.remainingUnits; candidate++) {
    const cost = localCostFor(curve, state.unitsSold, candidate);
    if (cost > budget) break;
    units = candidate;
  }
  if (units <= 0) throw new Error('Allocation is too small to buy one whole Liquid Split unit at the current curve price.');
  const cost = localCostFor(curve, state.unitsSold, units);
  const maxCost = Math.ceil(cost * 1.01);
  return { ...state, units, cost, maxCost };
}

async function buyOffering(options) {
  const provider = options && options.provider;
  const issuance = options && options.issuance;
  const buyer = options && options.buyer;
  const amountUsd = Number(options && options.amountUsd);
  if (!provider) throw new Error('Wallet provider is required.');
  if (!buyer) throw new Error('Connected wallet is required.');
  if (!issuance || !issuance.offeringAddress) throw new Error('Offering contract is not available.');

  await ensureBase(provider);
  const normalizedBuyer = getAddress(buyer);
  const offering = getAddress(issuance.offeringAddress);
  const paymentToken = getAddress(issuance.paymentToken || BASE_USDC_ADDRESS);
  const quote = await quoteOfferingPurchase({ issuance, amountUsd, provider, rpcUrl: options && options.rpcUrl });
  const allowance = await readContract({
    address: paymentToken,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [normalizedBuyer, offering],
    provider,
    rpcUrl: options && options.rpcUrl,
  });

  let approveTxHash = null;
  if (allowance < BigInt(quote.maxCost)) {
    approveTxHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{
        from: normalizedBuyer,
        to: paymentToken,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [offering, BigInt(quote.maxCost)],
        }),
        chainId: BASE_CHAIN_ID_HEX,
      }],
    });
    const approveReceipt = await waitForReceipt(provider, approveTxHash, options);
    if (approveReceipt.status && normalizeChainId(approveReceipt.status) === 0) throw new Error('USDC approval reverted.');
  }

  const buyTxHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from: normalizedBuyer,
      to: offering,
      data: encodeFunctionData({
        abi: OFFERING_ABI,
        functionName: 'buy',
        args: [BigInt(quote.units), BigInt(quote.maxCost)],
      }),
      chainId: BASE_CHAIN_ID_HEX,
    }],
  });
  const buyReceipt = await waitForReceipt(provider, buyTxHash, options);
  if (buyReceipt.status && normalizeChainId(buyReceipt.status) === 0) throw new Error('Offering purchase reverted.');
  let purchase = null;
  try {
    purchase = await getOfferingPurchaseFromReceipt({
      receipt: buyReceipt,
      offeringAddress: offering,
      buyer: normalizedBuyer,
    });
  } catch (err) {}
  return {
    ...quote,
    ...(purchase ? { units: purchase.units, cost: purchase.cost } : {}),
    approveTxHash,
    buyTxHash,
  };
}

window.PactLiquidSplit = {
  BASE_CHAIN_ID,
  BASE_CHAIN_ID_HEX,
  LIQUID_SPLIT_FACTORY_ADDRESS,
  BASE_USDC_ADDRESS,
  OFFERING_FACTORY_ADDRESS,
  OFFERING_FACTORY_ABI,
  OFFERING_ABI,
  TEMP_BONDING_CURVE_ADDRESS,
  buildLiquidSplitAllocations: issuance => buildLiquidSplitAllocations(issuance, { getAddress }),
  buildOfferingFactoryInputs: issuance => buildOfferingFactoryInputs(issuance, { getAddress }),
  deriveOfferingCurve,
  deployLiquidSplit,
  createOffering,
  getOfferingState,
  withdrawOffering,
  closeAndWithdrawOffering,
  markOfferingFailed,
  refundOffering,
  quoteOfferingPurchase,
  buyOffering,
  getOfferingPurchaseFromTx,
  getLiquidSplitTokenBalance,
  getLiquidSplitHolders,
};
