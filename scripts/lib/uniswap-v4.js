// The official Uniswap v4 contracts per chain, from developers.uniswap.org/docs/protocols/v4/deployments
// (each verified to carry code on Robinhood Chain mainnet). The launcher and the hook are deployed
// against these; nothing here is ours.
//
// Permit2 and the CREATE2 proxy sit at the same address on every chain.

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/// The deterministic deployment proxy, which the hook's address is mined against.
const CREATE2_PROXY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

const V4_BY_CHAIN = {
  4663: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
    permit2: PERMIT2,
  },
};

function v4AddressesFor(chainId) {
  return V4_BY_CHAIN[Number(chainId)] || null;
}

/**
 * The v4 addresses of the chain this run is pointed at, after checking every one of them has code.
 * Returns null when the chain has no Uniswap v4 deployment.
 */
async function v4For(hre, overrides = {}) {
  const { chainId } = await hre.ethers.provider.getNetwork();
  const base = v4AddressesFor(chainId);
  if (!base && !overrides.poolManager) return null;
  const set = { ...(base || {}), ...overrides };
  for (const [name, address] of Object.entries(set)) {
    const code = await hre.ethers.provider.getCode(address);
    if (code === "0x") throw new Error(`Uniswap v4 ${name} has no code at ${address} on chain ${chainId}`);
  }
  return set;
}

module.exports = { PERMIT2, CREATE2_PROXY, V4_BY_CHAIN, v4AddressesFor, v4For };
