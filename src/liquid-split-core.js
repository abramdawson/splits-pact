export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_ID_HEX = '0x2105';
export const BASE_CHAIN_PARAMS = {
  chainId: BASE_CHAIN_ID_HEX,
  chainName: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://mainnet.base.org'],
  blockExplorerUrls: ['https://basescan.org'],
};

export const LIQUID_SPLIT_FACTORY_ADDRESS = '0xdEcd8B99b7F763e16141450DAa5EA414B7994831';
export const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const TEMP_BONDING_CURVE_ADDRESS = '0xc6C8F6E4A73B2971C725359bb595Da1306FE5257';
export const TOTAL_LIQUID_SPLIT_UNITS = 1000;
export const ZERO_DISTRIBUTOR_FEE = 0;
export const USDC_SCALE = 1000000;

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}

function checksumOrLower(address, getAddress) {
  const trimmed = String(address || '').trim();
  if (!isAddress(trimmed)) throw new Error('Invalid address: ' + trimmed);
  return getAddress ? getAddress(trimmed) : trimmed.toLowerCase();
}

export function buildLiquidSplitAllocations(issuance, options = {}) {
  if (!issuance || typeof issuance !== 'object') throw new Error('Issuance is required.');
  const getAddress = options.getAddress;
  const bondingCurveAddress = options.bondingCurveAddress || TEMP_BONDING_CURVE_ADDRESS;
  const allocations = new Map();

  function add(address, amount) {
    const normalized = checksumOrLower(address, getAddress);
    const units = Number(amount);
    if (!Number.isInteger(units) || units < 0) {
      throw new Error('Liquid Split allocations must be whole token units.');
    }
    if (units === 0) return;
    // The factory mints ERC-1155 balances directly, so duplicate recipients must be
    // merged before the call instead of relying on contract-side normalization.
    const key = normalized.toLowerCase();
    const existing = allocations.get(key);
    allocations.set(key, {
      address: existing ? existing.address : normalized,
      units: (existing ? existing.units : 0) + units,
    });
  }

  (issuance.holders || []).forEach(holder => add(holder.address, holder.tokens));
  // Until the sale contract exists, the offering bucket goes to the operator-held
  // temporary recipient. Later this should become the bonding curve contract.
  add(bondingCurveAddress, issuance.newMoney && issuance.newMoney.tokens);

  const rows = Array.from(allocations.values()).sort((a, b) =>
    a.address.toLowerCase() > b.address.toLowerCase() ? 1 : -1
  );
  const total = rows.reduce((sum, row) => sum + row.units, 0);
  // Splits' default Liquid Split is exactly 1,000 units, where each unit is 0.1%.
  if (total !== TOTAL_LIQUID_SPLIT_UNITS) {
    throw new Error('Liquid Split allocations must total 1,000 token units.');
  }
  if (rows.length < 2) {
    throw new Error('Liquid Split requires at least two recipients.');
  }

  return {
    accounts: rows.map(row => row.address),
    initAllocations: rows.map(row => row.units),
  };
}

export function buildOfferingFactoryInputs(issuance, options = {}) {
  if (!issuance || typeof issuance !== 'object') throw new Error('Issuance is required.');
  const getAddress = options.getAddress;
  const allocations = buildLiquidSplitAllocations(issuance, {
    getAddress,
    bondingCurveAddress: options.offeringAddress || TEMP_BONDING_CURVE_ADDRESS,
  });
  const offeringUnits = Number(issuance.newMoney && issuance.newMoney.tokens);
  if (!Number.isInteger(offeringUnits) || offeringUnits <= 0) {
    throw new Error('Offering units must be a positive whole number.');
  }

  const holderAccounts = [];
  const holderAllocations = [];
  allocations.accounts.forEach((account, index) => {
    const units = allocations.initAllocations[index];
    if (String(account).toLowerCase() === String(options.offeringAddress || TEMP_BONDING_CURVE_ADDRESS).toLowerCase()) return;
    holderAccounts.push(account);
    holderAllocations.push(units);
  });

  const total = holderAllocations.reduce((sum, units) => sum + units, 0) + offeringUnits;
  if (total !== TOTAL_LIQUID_SPLIT_UNITS) {
    throw new Error('Offering factory allocations must total 1,000 token units.');
  }

  return { holderAccounts, holderAllocations, offeringUnits };
}

export function toUsdcBaseUnits(dollars) {
  const n = Number(dollars);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n * USDC_SCALE);
}

export function deriveOfferingCurve(issuance) {
  const floor = Number(issuance && issuance.valuation && issuance.valuation.floor);
  const ceiling = Number(issuance && issuance.valuation && issuance.valuation.ceiling);
  const offeringUnits = Number(issuance && issuance.newMoney && issuance.newMoney.tokens);
  if (!(floor > 0) || !(ceiling >= floor) || !(offeringUnits > 0)) {
    throw new Error('Valid valuation band and offering units are required.');
  }
  const priceStart = Math.max(1, Math.floor(floor * USDC_SCALE / TOTAL_LIQUID_SPLIT_UNITS));
  const slopeRaw = Math.floor((ceiling - floor) * USDC_SCALE / TOTAL_LIQUID_SPLIT_UNITS / offeringUnits);
  const priceSlope = ceiling > floor ? Math.max(1, slopeRaw) : 0;
  return { priceStart, priceSlope };
}
