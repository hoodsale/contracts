// Loads sample data onto the local network: 3 token types, presales in every state and five quick presales
// (one live, one launched, one live with a creator tax, one launched Rewards token with DEX trades, one
// launched Rewards token paying the mock tokenized stock TSLA through the mock Uniswap V3).
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ETH = (n) => hre.ethers.parseEther(String(n));

async function main() {
  const signers = await hre.ethers.getSigners();
  const [deployer, alice, bob, carol, dave] = signers;
  const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file));

  const tokenFactory = await hre.ethers.getContractAt("TokenFactory", d.tokenFactory);
  const presaleFactory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory);
  // QuickLaunch.distributeRewards takes the factory's launch keeper or the QuickLaunch owner (the
  // deployer) only, so the distributions below are sent by the keeper wallet when it is one of
  // the configured signers (deploy.js: LAUNCH_KEEPER, the deployer by default), else by the deployer
  const launchKeeperAddr = await presaleFactory.launchKeeper();
  const keeper = signers.find((s) => s.address.toLowerCase() === launchKeeperAddr.toLowerCase()) || deployer;

  const nowTs = async () => (await hre.ethers.provider.getBlock("latest")).timestamp;

  // --- Tokens ---
  await (await tokenFactory.createStandardToken("Hood Doge", "HDOGE", ETH(1_000_000))).wait();
  await (
    await tokenFactory.createTaxToken("Hood Cat", "HCAT", ETH(500_000), deployer.address, 300, 400)
  ).wait();
  const wethAddr = await (await hre.ethers.getContractAt("MockRouter", d.router)).WETH();
  await (
    await tokenFactory.createRewardsToken(
      "Hood Tesla", "HTSLA", ETH(2_000_000), wethAddr, deployer.address,
      [200, 200, 100, 100]
    )
  ).wait();

  const tokens = [];
  for (let i = 0; i < 3; i++) tokens.push(await tokenFactory.allTokens(i));
  console.log("Tokens:", tokens);

  // The mock USDG (a reward token quick Rewards sales may pick) gets its WETH pool: 20,000 USDG / 10 ETH
  if (d.usdg) {
    const usdg = await hre.ethers.getContractAt("MockERC20", d.usdg);
    const usdgRouter = await hre.ethers.getContractAt("MockRouter", d.router);
    const usdgAmount = 20_000n * 10n ** BigInt(await usdg.decimals());
    await (await usdg.approve(d.router, usdgAmount)).wait();
    await (
      await usdgRouter.addLiquidityETH(d.usdg, usdgAmount, 0, 0, deployer.address, (await nowTs()) + 600, { value: ETH(10) })
    ).wait();
    console.log("USDG/WETH pool:", d.usdg);
  }

  // --- Presales ---
  // Sale size fields, shared by createPresale and the sale-derived tokenomics slices below
  const saleShape = (opts) => ({
    presaleRate: ETH(opts.presaleRate ?? 1000),
    listingRate: ETH(opts.listingRate ?? 800),
    hardCap: ETH(8),
    liquidityBps: 6000,
  });
  async function createPresale(token, opts) {
    const t0 = await nowTs();
    const p = {
      token,
      ...saleShape(opts),
      softCap: ETH(2),
      minContribution: ETH(0.1),
      maxContribution: ETH(4),
      startTime: t0 + opts.startsIn,
      endTime: t0 + opts.endsIn,
      liquidityAction: opts.burn ? 1 : 0,
      lockDuration: 180 * 24 * 3600,
      launchTime: 0,
      whitelistEnabled: false,
    };
    const required = await presaleFactory.requiredTokensFor(p);
    const t = await hre.ethers.getContractAt("StandardToken", token);
    await (await t.approve(presaleFactory.target, required)).wait();
    // The creation fee is a factory setting (none on mainnet); pay whatever the factory asks
    await (await presaleFactory.createPresale(p, { value: await presaleFactory.creationFee() })).wait();
    const idx = (await presaleFactory.allPresalesLength()) - 1n;
    return await presaleFactory.allPresales(idx);
  }

  // 1) Live presale (with contributions)
  // 48% of supply on sale, ~20.7% in liquidity; the tokenomics plan below is derived from these values
  const liveOpts = {
    startsIn: 5,
    endsIn: 30 * 24 * 3600,
    presaleRate: 60_000,
    listingRate: 48_000,
  };
  const live = await createPresale(tokens[0], liveOpts);
  await hre.network.provider.send("evm_increaseTime", [10]);
  await hre.network.provider.send("evm_mine");
  const liveSale = await hre.ethers.getContractAt("Presale", live);
  await (await liveSale.connect(alice).contribute({ value: ETH(1.5) })).wait();
  await (await liveSale.connect(bob).contribute({ value: ETH(0.8) })).wait();
  await (await liveSale.connect(carol).contribute({ value: ETH(0.4) })).wait();
  // dave joins and exits early so that "Exit" shows up in the activity feed
  await (await liveSale.connect(dave).contribute({ value: ETH(0.3) })).wait();
  await (await liveSale.connect(dave).emergencyWithdraw()).wait();

  // 2) Upcoming presale (LP burn)
  const upcoming = await createPresale(tokens[1], {
    startsIn: 3 * 24 * 3600,
    endsIn: 20 * 24 * 3600,
    burn: true,
  });

  // 3) Live presale with a rewards token
  const rewardsSale = await createPresale(tokens[2], {
    startsIn: 20,
    endsIn: 45 * 24 * 3600,
    presaleRate: 100_000, // 40% of supply on sale
    listingRate: 80_000, // ~17% in liquidity
  });
  await hre.network.provider.send("evm_increaseTime", [30]);
  await hre.network.provider.send("evm_mine");
  const rs = await hre.ethers.getContractAt("Presale", rewardsSale);
  await (await rs.connect(alice).contribute({ value: ETH(2.5) })).wait();

  // 4) Completed launch: finalized and trading on the market
  await (await tokenFactory.createStandardToken("Hood Rocket", "HROCK", ETH(1_000_000))).wait();
  const launchedToken = await tokenFactory.allTokens(3);
  const launched = await createPresale(launchedToken, { startsIn: 5, endsIn: 900, burn: true });
  await hre.network.provider.send("evm_increaseTime", [10]);
  await hre.network.provider.send("evm_mine");
  const ls = await hre.ethers.getContractAt("Presale", launched);
  await (await ls.connect(alice).contribute({ value: ETH(4) })).wait();
  await (await ls.connect(bob).contribute({ value: ETH(3) })).wait();
  await hre.network.provider.send("evm_increaseTime", [1000]);
  await hre.network.provider.send("evm_mine");
  await (await ls.finalize(0, 0)).wait();
  await (await ls.connect(alice).claim()).wait(); // activity: Claim

  // 5) Cancelled presale: the contributor receives a full refund (activity: Refund)
  await (await tokenFactory.createStandardToken("Hood Ghost", "HGHOST", ETH(1_000_000))).wait();
  const cancelledToken = await tokenFactory.allTokens(4);
  const cancelled = await createPresale(cancelledToken, { startsIn: 5, endsIn: 900 });
  await hre.network.provider.send("evm_increaseTime", [10]);
  await hre.network.provider.send("evm_mine");
  const cs = await hre.ethers.getContractAt("Presale", cancelled);
  await (await cs.connect(bob).contribute({ value: ETH(1) })).wait();
  await (await cs.cancel()).wait();
  await (await cs.connect(bob).claimRefund()).wait();

  // Post-launch buys push the price up
  const routerC = await hre.ethers.getContractAt("MockRouter", d.router);
  const weth = wethAddr;
  const deadline = (await hre.ethers.provider.getBlock("latest")).timestamp + 600;
  for (const signer of [carol, bob]) {
    await (
      await routerC
        .connect(signer)
        .swapExactETHForTokens(0, [weth, launchedToken], signer.address, deadline, { value: ETH(1.5) })
    ).wait();
  }

  // --- Token profiles (logo, banner, description, social media) ---
  const registry = await hre.ethers.getContractAt("TokenMetadataRegistry", d.metadataRegistry);
  const profiles = [
    {
      token: tokens[0],
      logoURI: "https://api.dicebear.com/9.x/shapes/svg?seed=hooddoge",
      bannerURI: "https://picsum.photos/seed/hooddoge/1200/300",
      description:
        "Hood Doge is a community token launched on HoodSale. Fair launch, locked liquidity and a transparent tax structure.",
      website: "https://hooddoge.example",
      twitter: "https://x.com/hooddoge",
      telegram: "https://t.me/hooddoge",
      discord: "",
      updatedAt: 0,
    },
    {
      token: tokens[2],
      logoURI: "https://api.dicebear.com/9.x/shapes/svg?seed=hoodtesla",
      bannerURI: "https://picsum.photos/seed/hoodtesla/1200/300",
      description:
        "Hood Tesla pays holders rewards in a Robinhood tokenized stock. Hold the token, collect the dividend.",
      website: "https://hoodtesla.example",
      twitter: "https://x.com/hoodtesla",
      telegram: "",
      discord: "https://discord.gg/hoodtesla",
      updatedAt: 0,
    },
    {
      token: launchedToken,
      logoURI: "https://api.dicebear.com/9.x/shapes/svg?seed=hoodrocket",
      bannerURI: "https://picsum.photos/seed/hoodrocket/1200/300",
      description: "Hood Rocket completed its presale with burned liquidity and is now trading.",
      website: "https://hoodrocket.example",
      twitter: "https://x.com/hoodrocket",
      telegram: "https://t.me/hoodrocket",
      discord: "",
      updatedAt: 0,
    },
  ];
  for (const p of profiles) {
    const { token, ...meta } = p;
    await (await registry.setMetadata(token, meta)).wait();
  }
  // Profile of the platform's own token (eligible through the allowlist)
  await (
    await registry.setMetadata(d.hoodsale, {
      logoURI: "https://api.dicebear.com/9.x/shapes/svg?seed=hoodsale",
      bannerURI: "https://picsum.photos/seed/hoodsale/1200/300",
      description:
        "HOODS is the token of the launchpad it trades on. Fixed supply of 100,000,000, a 3% tax on pool trades that funds marketing and buybacks, and a treasury that ring fences 30% of platform revenue to buy it back and burn it.",
      website: "https://hoodsale.example",
      twitter: "https://x.com/hoodsale",
      telegram: "https://t.me/hoodsale",
      discord: "",
      updatedAt: 0,
    })
  ).wait();

  // --- Tokenomics (supply distribution declarations) ---
  // Presale and Liquidity come from the sale settings: the same formula as
  // PresaleFactory.requiredTokensFor, expressed in bps of the supply (rounded half up).
  const BPS = 10_000n;
  const feeBps = await presaleFactory.platformFeeBps();
  const saleSlices = (p, totalSupply, liquidityNote) => {
    const tokensForSale = (p.hardCap * p.presaleRate) / ETH(1);
    const netEth = p.hardCap - (p.hardCap * feeBps) / BPS;
    const liquidityEth = (netEth * BigInt(p.liquidityBps)) / BPS;
    const tokensForLiquidity = (liquidityEth * p.listingRate) / ETH(1);
    const toBps = (amount) => Number((amount * BPS * 2n + totalSupply) / (2n * totalSupply));
    return [
      { label: "Presale", bps: toBps(tokensForSale), note: "" },
      { label: "Liquidity", bps: toBps(tokensForLiquidity), note: liquidityNote },
    ];
  };
  // Whatever the slices leave unassigned stays in the owner wallet, written as a real
  // slice so the on-chain sum is always exactly 10000.
  const withRemainder = (slices) => {
    const used = slices.reduce((sum, s) => sum + s.bps, 0);
    if (used > 10_000) throw new Error("tokenomics plan exceeds 100%");
    return used < 10_000
      ? [...slices, { label: "Unallocated", bps: 10_000 - used, note: "Owner wallet" }]
      : slices;
  };
  const hdoge = await hre.ethers.getContractAt("StandardToken", tokens[0]);
  const hoodsale = await hre.ethers.getContractAt("HoodSaleToken", d.hoodsale);
  // Sale size of the HOODS presale (created further down): 500 seats of 0.1 ETH, the shape
  // the whitelist raffle fills (seats = hard cap / max contribution)
  const hsShape = {
    presaleRate: ETH(800_000), // 40M HOODS on sale (40%)
    listingRate: ETH(640_000), // ~25M in liquidity (24.96%)
    hardCap: ETH(50),
    liquidityBps: 8000,
  };
  const plans = {
    [tokens[0]]: withRemainder([
      ...saleSlices(saleShape(liveOpts), await hdoge.totalSupply(), "Locked 180 days"),
      // The sale slices grow with a lower platform share (2.5% on mainnet), so the fixed slices
      // leave room for them and a small unallocated remainder
      { label: "Community", bps: 1200, note: "Airdrops and rewards" },
      { label: "Team", bps: 1000, note: "12 month vesting" },
      { label: "Marketing", bps: 600, note: "" },
    ]),
    [tokens[2]]: [
      { label: "Presale", bps: 4000, note: "" },
      { label: "Liquidity", bps: 1700, note: "Locked 180 days" },
      { label: "Rewards pool", bps: 2500, note: "Holder dividends" },
      { label: "Team", bps: 1000, note: "6 month vesting" },
      { label: "Marketing", bps: 800, note: "" },
    ],
    // Team and Marketing are the same size. The card attributes a lock to the first row
    // of that size in plan order, so Team (the locked one) is listed before Marketing.
    [d.hoodsale]: withRemainder([
      ...saleSlices(hsShape, await hoodsale.totalSupply(), "Locked 365 days"),
      { label: "Treasury", bps: 1500, note: "Buybacks and operations" },
      { label: "Team", bps: 1000, note: "24 month vesting" },
      { label: "Marketing", bps: 1000, note: "" },
    ]),
  };
  for (const [token, slices] of Object.entries(plans)) {
    await (await registry.setTokenomics(token, slices)).wait();
  }
  console.log("Tokenomics:", {
    hdoge: plans[tokens[0]].map((s) => `${s.label} ${s.bps}`).join(", "),
    hoodsale: plans[d.hoodsale].map((s) => `${s.label} ${s.bps}`).join(", "),
  });

  // --- Team locks through the platform locker (Marketing stays unlocked on purpose) ---
  // Locks the exact slice amount from the deployer wallet; the deployer keeps ownership of the lock.
  const locker = await hre.ethers.getContractAt("LiquidityLocker", d.locker);
  async function lockSlice(tokenContract, bps, days) {
    const amount = ((await tokenContract.totalSupply()) * BigInt(bps)) / BPS;
    const unlockTime = (await nowTs()) + days * 24 * 3600;
    await (await tokenContract.approve(locker.target, amount)).wait();
    await (await locker.lock(tokenContract.target, amount, unlockTime, deployer.address)).wait();
    return Number((await locker.lockCount()) - 1n);
  }
  const hdogeTeamLock = await lockSlice(hdoge, 1000, 365);
  const hoodsaleTeamLock = await lockSlice(hoodsale, 1000, 730);
  console.log("Team locks:", { hdoge: hdogeTeamLock, hoodsale: hoodsaleTeamLock });

  // --- the HOODS presale (the platform's flagship sale) ---
  // Upcoming and whitelist only, the state the whitelist raffle attaches to: every wallet puts
  // in exactly 0.1 ETH, so the 50 ETH hard cap is 500 seats. The list is empty until the raffle
  // result is written to it; the sale starts two weeks out to leave room for the raffle.
  const hsNow = await nowTs();
  const hsStart = hsNow + 14 * 24 * 3600;
  const hsParams = {
    token: d.hoodsale,
    ...hsShape,
    softCap: ETH(12.5),
    minContribution: ETH(0.1),
    maxContribution: ETH(0.1),
    startTime: hsStart,
    endTime: hsStart + 2 * 24 * 3600,
    liquidityAction: 0, // liquidity is locked
    lockDuration: 365 * 24 * 3600,
    launchTime: 0,
    whitelistEnabled: true, // HOODS starts with the whitelist enabled
  };
  const hsRequired = await presaleFactory.requiredTokensFor(hsParams);
  await (await hoodsale.approve(presaleFactory.target, hsRequired)).wait();
  await (await presaleFactory.createPresale(hsParams, { value: await presaleFactory.creationFee() })).wait();
  const hoodsalePresale = await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n);
  console.log("HOODS presale:", hoodsalePresale);

  const lens = await hre.ethers.getContractAt("HoodSaleLens", d.lens);
  const [launches] = await lens.launchViews(0, 10);
  for (const l of launches) {
    console.log(`Launched ${l.symbol}: ${(Number(l.multiplierX18) / 1e18).toFixed(2)}x`);
  }

  console.log("Presales:", { live, upcoming, rewardsSale, launched });
  // 6) Extra sales to fill the trending strip: different contribution paces and one upcoming sale
  const extras = [
    { name: "Hood Pepe", symbol: "HPEPE", wallets: [[5, 1.2], [6, 0.8], [7, 0.5], [8, 0.3]] },
    { name: "Hood Lion", symbol: "HLION", wallets: [[9, 3.5], [10, 1.5]] },
    { name: "Hood Owl", symbol: "HOWL", wallets: [[11, 0.6], [12, 0.4], [13, 0.2]] },
    { name: "Hood Wolf", symbol: "HWOLF", wallets: [[14, 2.0]] },
  ];
  for (const x of extras) {
    await (await tokenFactory.createStandardToken(x.name, x.symbol, ETH(1_000_000))).wait();
    const tokenAddr = await tokenFactory.allTokens((await tokenFactory.allTokensLength()) - 1n);
    const saleAddr = await createPresale(tokenAddr, { startsIn: 5, endsIn: 20 * 24 * 3600 });
    await hre.network.provider.send("evm_increaseTime", [10]);
    await hre.network.provider.send("evm_mine");
    const sale = await hre.ethers.getContractAt("Presale", saleAddr);
    for (const [i, amount] of x.wallets) {
      await (await sale.connect(signers[i]).contribute({ value: ETH(amount) })).wait();
    }
  }
  // An upcoming, whitelisted sale
  await (await tokenFactory.createStandardToken("Hood Fox", "HFOX", ETH(1_000_000))).wait();
  const foxAddr = await tokenFactory.allTokens((await tokenFactory.allTokensLength()) - 1n);
  const foxSale = await hre.ethers.getContractAt(
    "Presale",
    await createPresale(foxAddr, { startsIn: 12 * 3600, endsIn: 15 * 24 * 3600 })
  );
  await (await foxSale.setWhitelistEnabled(true)).wait();
  await (await foxSale.addToWhitelist(signers.slice(5, 17).map((w) => w.address))).wait();

  // --- Owner locks ---
  // HCAT (the Tax token with the upcoming sale): rates and tax wallet frozen, exemptions open.
  // HFOX (the whitelisted sale): ownership renounced after the sale was created, so the sale
  // page and the token page show a token nobody can change, with the profile kept by the deployer.
  const hcat = await hre.ethers.getContractAt("TaxToken", tokens[1]);
  await (await hcat.lock((await hcat.LOCK_TAXES()) | (await hcat.LOCK_TAX_WALLET()))).wait();
  const hfox = await hre.ethers.getContractAt("StandardToken", foxAddr);
  await (await hfox.lock(await hfox.LOCK_OWNERSHIP())).wait();
  console.log("Locks: HCAT taxes and wallet locked, HFOX renounced");

  // --- Quick presales (QuickLaunch: token + sale with locked rules in one transaction) ---
  const quickLaunch = await hre.ethers.getContractAt("QuickLaunch", d.quickLaunch);
  const quickFee = await presaleFactory.quickCreationFee();
  // token: { tokenType (0 Standard, 1 Tax, 2 Rewards), taxWallet, buyTax, sellTax, rewardToken, rewardsBuy, rewardsSell }
  // in bps; the tax is the creator tax of a Tax token and the marketing tax of a Rewards token
  async function launchQuick(creator, name, symbol, hardCapEth, durationOption, sharePercent, seed, description, token = {}) {
    const tx = await quickLaunch.connect(creator).launch(
      {
        name,
        symbol,
        hardCap: ETH(hardCapEth),
        durationOption,
        creatorSharePercent: sharePercent,
        tokenType: token.tokenType ?? 0,
        rewardToken: token.rewardToken ?? hre.ethers.ZeroAddress,
        taxWallet: token.taxWallet ?? hre.ethers.ZeroAddress,
        buyTaxBps: token.buyTax ?? 0,
        sellTaxBps: token.sellTax ?? 0,
        rewardsBuyBps: token.rewardsBuy ?? 0,
        rewardsSellBps: token.rewardsSell ?? 0,
        logoURI: `https://api.dicebear.com/9.x/shapes/svg?seed=${seed}`,
        description,
      },
      { value: quickFee }
    );
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l) => {
        try {
          return quickLaunch.interface.parseLog(l);
        } catch (e) {
          return null;
        }
      })
      .find((e) => e && e.name === "QuickLaunched");
    return { token: ev.args.token, presale: ev.args.presale };
  }

  // 7) Live quick presale: 2 ETH hard cap, 1 hour, the creator keeps 5% of the raise (max 0.04 ETH per wallet)
  const flash = await launchQuick(
    carol, "Hood Flash", "HFLASH", 2, 1, 0, "hoodflash",
    "Hood Flash is a quick presale: fixed rules, automatic launch at the hard cap or at the end, tokens delivered without a claim."
  );
  const flashSale = await hre.ethers.getContractAt("Presale", flash.presale);
  await (await flashSale.connect(alice).contribute({ value: ETH(0.04) })).wait();
  await (await flashSale.connect(bob).contribute({ value: ETH(0.025) })).wait();
  // The creator adds the links while the sale runs: quick tokens have no owner, the registry
  // lets the QuickLaunch creator edit the profile at any time. setMetadata replaces the whole
  // record, so the logo and the description written at the launch are sent again.
  const flashProfile = await registry.metadataOf(flash.token);
  await (
    await registry.connect(carol).setMetadata(flash.token, {
      logoURI: flashProfile.logoURI,
      bannerURI: flashProfile.bannerURI,
      description: flashProfile.description,
      website: "https://hoodflash.example",
      twitter: "https://x.com/hoodflash",
      telegram: "",
      discord: "",
      updatedAt: 0,
    })
  ).wait();

  // 8) Quick presale that already launched: 1 ETH hard cap filled by 50 wallets (2% each),
  //    the filling contribution launched it and paid the first 20 wallets, distribute() did the rest
  const spark = await launchQuick(
    dave, "Hood Spark", "HSPARK", 1, 0, 0, "hoodspark",
    "Hood Spark filled its hard cap within minutes and launched automatically. Liquidity is burned and every participant received their tokens."
  );
  const sparkSale = await hre.ethers.getContractAt("Presale", spark.presale);
  for (let i = 0; i < 50; i++) {
    const w = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
    await (await deployer.sendTransaction({ to: w.address, value: ETH(0.05) })).wait();
    await (await sparkSale.connect(w).contribute({ value: ETH(0.02) })).wait();
  }
  // What the keeper does after a launch: deliver the remaining tokens in batches of 100
  while (!(await sparkSale.distributionComplete())) await (await sparkSale.distribute(100)).wait();
  const [sent, total] = await sparkSale.distributionProgress();

  // 9) Live quick presale with a creator tax: a TaxToken paid to the creator, 2% on buys and
  //    2% on sells on top of the platform tax, fixed forever (the token has no owner)
  const htax = await launchQuick(
    bob, "Hood Tax", "HTAX", 2, 2, 0, "hoodtax",
    "Hood Tax is a quick presale whose token carries a 2% creator tax on every pool buy and sell, fixed at launch.",
    { tokenType: 1, buyTax: 200, sellTax: 200 }
  );
  const htaxSale = await hre.ethers.getContractAt("Presale", htax.presale);
  await (await htaxSale.connect(alice).contribute({ value: ETH(0.04) })).wait();
  await (await htaxSale.connect(carol).contribute({ value: ETH(0.03) })).wait();
  await (await htaxSale.connect(dave).contribute({ value: ETH(0.01) })).wait();
  const htaxToken = await hre.ethers.getContractAt("TaxToken", htax.token);

  // 10) Quick presale of a Rewards token, launched and trading: holders earn WETH (3% of every
  //     pool buy and sell) and 1%/1% marketing goes to carol; 2 ETH hard cap filled by 50 wallets
  //     (0.04 ETH each), then a few DEX trades, one reward distribution and fresh pending rewards
  const hyld = await launchQuick(
    alice, "Hood Yield", "HYLD", 2, 1, 0, "hoodyield",
    "Hood Yield pays its holders rewards in WETH: 3% of every pool buy and sell is swapped and shared per token held. 1% goes to marketing. The token is owned by the launchpad's QuickLaunch, which can change nothing.",
    { tokenType: 2, rewardToken: wethAddr, taxWallet: carol.address, buyTax: 100, sellTax: 100, rewardsBuy: 300, rewardsSell: 300 }
  );
  const hyldSale = await hre.ethers.getContractAt("Presale", hyld.presale);
  const hyldToken = await hre.ethers.getContractAt("RewardsToken", hyld.token);
  const hyldHolders = [];
  for (let i = 0; i < 50; i++) {
    const w = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
    await (await deployer.sendTransaction({ to: w.address, value: ETH(0.1) })).wait();
    await (await hyldSale.connect(w).contribute({ value: ETH(0.04) })).wait();
    hyldHolders.push(w);
  }
  while (!(await hyldSale.distributionComplete())) await (await hyldSale.distribute(100)).wait();
  const hyldDeadline = async () => (await nowTs()) + 600;
  // Two buys accumulate rewards past the swap threshold, a sell triggers the marketing swap-back
  for (const [signer, amount] of [[bob, 0.2], [dave, 0.1]]) {
    await (
      await routerC.connect(signer).swapExactETHForTokens(0, [weth, hyld.token], signer.address, await hyldDeadline(), { value: ETH(amount) })
    ).wait();
  }
  const sellAmount = (await hyldToken.balanceOf(hyldHolders[0].address)) / 2n;
  await (await hyldToken.connect(hyldHolders[0]).approve(d.router, sellAmount)).wait();
  await (
    await routerC
      .connect(hyldHolders[0])
      .swapExactTokensForETHSupportingFeeOnTransferTokens(sellAmount, 0, [hyld.token, weth], hyldHolders[0].address, await hyldDeadline())
  ).wait();
  // What the keeper does: distribute through QuickLaunch (the launch keeper or the QuickLaunch
  // owner; a stranger is refused with "not keeper"), holders can then claim
  await (await quickLaunch.connect(keeper).distributeRewards(hyld.token, 0)).wait();
  await (await hyldToken.connect(hyldHolders[1]).claimRewards()).wait();
  // One more buy leaves rewards pending for the next distribution
  await (
    await routerC.connect(bob).swapExactETHForTokens(0, [weth, hyld.token], bob.address, await hyldDeadline(), { value: ETH(0.05) })
  ).wait();

  // 11) Quick presale of a Rewards token paying a tokenized stock (the mock TSLA that trades
  //     against WETH on the mock Uniswap V3 at 0.3%): the launch applies the V3 path QuickLaunch
  //     stores for TSLA, 50 wallets fill the 2 ETH hard cap, a buy accrues rewards, the keeper
  //     wallet triggers the distribution through QuickLaunch and a holder claims TSLA
  let hstk = null;
  if (d.tsla) {
    const tslaToken = await hre.ethers.getContractAt("MockERC20", d.tsla);
    hstk = await launchQuick(
      bob, "Hood Stock", "HSTK", 2, 1, 0, "hoodstock",
      "Hood Stock pays its holders dividends in tokenized Tesla stock: 3% of every pool buy and sell is swapped through Uniswap V3 into TSLA and shared per token held.",
      { tokenType: 2, rewardToken: d.tsla, taxWallet: bob.address, buyTax: 100, sellTax: 100, rewardsBuy: 300, rewardsSell: 300 }
    );
    const hstkSale = await hre.ethers.getContractAt("Presale", hstk.presale);
    const hstkToken = await hre.ethers.getContractAt("RewardsToken", hstk.token);
    const hstkHolders = [];
    for (let i = 0; i < 50; i++) {
      const w = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
      await (await deployer.sendTransaction({ to: w.address, value: ETH(0.1) })).wait();
      await (await hstkSale.connect(w).contribute({ value: ETH(0.04) })).wait();
      hstkHolders.push(w);
    }
    while (!(await hstkSale.distributionComplete())) await (await hstkSale.distribute(100)).wait();
    await (
      await routerC.connect(carol).swapExactETHForTokens(0, [weth, hstk.token], carol.address, await hyldDeadline(), { value: ETH(0.3) })
    ).wait();
    await (await quickLaunch.connect(keeper).distributeRewards(hstk.token, 0)).wait();
    await (await hstkToken.connect(hstkHolders[1]).claimRewards()).wait();
    await (
      await routerC.connect(dave).swapExactETHForTokens(0, [weth, hstk.token], dave.address, await hyldDeadline(), { value: ETH(0.05) })
    ).wait();
    console.log("Stock rewards:", {
      presale: hstk.presale,
      token: hstk.token,
      routeV3: await hstkToken.rewardRouteV3(),
      distributed: `${hre.ethers.formatEther(await hstkToken.totalRewardsDistributed())} TSLA`,
      claimed: `${hre.ethers.formatEther(await tslaToken.balanceOf(hstkHolders[1].address))} TSLA by ${hstkHolders[1].address}`,
      pending: `${hre.ethers.formatEther(await hstkToken.pendingRewardsTokens())} HSTK`,
    });
  }

  console.log("Quick presales:", {
    live: flash.presale,
    launched: spark.presale,
    launchedStatus: (await sparkSale.status()).toString(),
    delivered: `${sent}/${total}`,
    taxed: htax.presale,
    taxedToken: `${await htaxToken.buyTaxBps()}/${await htaxToken.sellTaxBps()} bps to ${await htaxToken.marketingWallet()}`,
    rewards: hyld.presale,
    rewardsToken: hyld.token,
    rewardsStatus: (await hyldSale.status()).toString(),
    rewardsDistributed: `${hre.ethers.formatEther(await hyldToken.totalRewardsDistributed())} WETH, pending ${hre.ethers.formatEther(await hyldToken.pendingRewardsTokens())} HYLD, owner ${await hyldToken.owner()}`,
    stockRewards: hstk ? hstk.presale : "-",
  });

  console.log("Seed complete.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
