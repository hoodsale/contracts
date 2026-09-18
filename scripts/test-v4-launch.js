// The first real launch into a Uniswap v4 pool, run end to end from the terminal: it creates a
// small Tax token for a v4 pool, opens a presale for it, fills the sale, finalizes it so the pool
// opens, buys a little through the site's router to prove the tax is charged, and sends the
// collected fees on to their owners. Everything happens from the deployer wallet.
//
//   DEPLOYER_KEY=0x... npx hardhat run scripts/test-v4-launch.js --network robinhood
//
// What it spends: the sale's hard cap (HARD_CAP, default 0.02 ETH) plus gas, plus the small test
// buy (TEST_BUY, default 0.002 ETH). Of the hard cap, the platform takes its 2.5% into the
// Treasury, the liquidity share is locked in the pool for 30 days (the wallet can take it back
// afterwards), and the rest comes straight back to the wallet at finalize. All the tokens stay in
// the wallet too.
//
// Optional environment:
//   NAME, SYMBOL      the token (default "HoodSale V4", "HSV4")
//   HARD_CAP          the sale size in ETH (default 0.02)
//   TEST_BUY          the router buy in ETH (default 0.002)
//   TOKEN=0x...       reuse a token this script already created, instead of making another
//   PRESALE=0x...     reuse a presale this script already opened
//
// Nothing here prints or stores a private key.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const { ethers } = hre;
const E = ethers.parseEther;
const DAY = 86400n;
const LOCK = 0;
const TAX = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tx = (hash) => `https://robin.etherscan.io/tx/${hash}`;
const addr = (a) => `https://robin.etherscan.io/address/${a}`;

async function send(label, promise) {
  const t = await promise;
  const r = await t.wait();
  console.log(`  ${label}: ${tx(t.hash)}`);
  return r;
}

async function main() {
  const network = hre.network.name;
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network}.json`), "utf8"));
  for (const k of ["v4Launcher", "v4Hook", "v4Router", "presaleFactory", "lens", "treasury"]) {
    if (!d[k]) throw new Error(`deployments/${network}.json lacks ${k}: run scripts/deploy-v4.js first`);
  }
  const [me] = await ethers.getSigners();
  if (!me) throw new Error("no signer: set DEPLOYER_KEY");

  const hardCap = E(process.env.HARD_CAP || "0.02");
  const testBuy = E(process.env.TEST_BUY || "0.002");
  const name = process.env.NAME || "HoodSale V4";
  const symbol = process.env.SYMBOL || "HSV4";

  const balance = await ethers.provider.getBalance(me.address);
  console.log(`Wallet ${me.address}, balance ${ethers.formatEther(balance)} ETH`);
  const needed = hardCap + testBuy + E("0.002"); // the rest is gas headroom
  if (balance < needed) {
    throw new Error(`not enough ETH: the launch needs about ${ethers.formatEther(needed)} ETH`);
  }

  const launcher = await ethers.getContractAt("V4Launcher", d.v4Launcher, me);
  const presaleFactory = await ethers.getContractAt("PresaleFactory", d.presaleFactory, me);
  const hook = await ethers.getContractAt("HoodSaleV4Hook", d.v4Hook, me);
  const router = await ethers.getContractAt("HoodSaleV4Router", d.v4Router, me);
  const lens = await ethers.getContractAt("HoodSaleLens", d.lens, me);
  const treasury = await ethers.getContractAt("Treasury", d.treasury, me);

  // ------------------------------------------------------------ 1. token

  let tokenAddr = process.env.TOKEN;
  if (tokenAddr) {
    console.log(`\n1. Using the token ${tokenAddr}`);
  } else {
    console.log(`\n1. Creating ${name} (${symbol}) for a Uniswap v4 pool, 1% buy and 1% sell tax`);
    await send(
      "created",
      launcher.createToken(
        TAX,
        { name, symbol, totalSupply: E("1000000"), rewardToken: ethers.ZeroAddress },
        {
          marketingWallet: me.address,
          marketingBuyBps: 100,
          marketingSellBps: 100,
          rewardsBuyBps: 0,
          rewardsSellBps: 0,
          taxLocked: false,
          walletLocked: false,
        },
        me.address
      )
    );
    const mine = await launcher.tokensOfCreator(me.address);
    tokenAddr = mine[mine.length - 1];
    console.log(`  token ${tokenAddr}`);
  }
  const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr, me);

  // ------------------------------------------------------------ 2. presale

  let presaleAddr = process.env.PRESALE;
  if (presaleAddr) {
    console.log(`\n2. Using the presale ${presaleAddr}`);
  } else {
    const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    const start = now + 60n;
    // 20M tokens per ETH in the sale, listed at 16M per ETH, so the sale buys below the listing.
    const params = {
      token: tokenAddr,
      presaleRate: E("20000000"),
      listingRate: E("16000000"),
      softCap: hardCap / 4n,
      hardCap,
      minContribution: hardCap / 20n,
      maxContribution: hardCap,
      startTime: start,
      endTime: start + DAY,
      liquidityBps: 6000,
      liquidityAction: LOCK,
      lockDuration: 30n * DAY,
      launchTime: 0,
      whitelistEnabled: false,
    };
    const required = await presaleFactory.requiredTokensFor(params);
    console.log(`\n2. Opening a ${ethers.formatEther(hardCap)} ETH presale, 60% liquidity locked for 30 days`);
    await send("approved", token.approve(d.presaleFactory, required));
    const fee = await presaleFactory.creationFee();
    await send("presale created", presaleFactory.createPresale(params, { value: fee }));
    presaleAddr = await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n);
    console.log(`  presale ${presaleAddr}`);
  }
  const presale = await ethers.getContractAt("Presale", presaleAddr, me);
  if (!(await presale.isV4Launch())) throw new Error("this presale would not list on Uniswap v4");

  // ------------------------------------------------------ 3. fill and launch

  const params = await presale.getParams();
  const state = Number(await presale.state());
  if (state === 0) {
    process.stdout.write("\n3. Waiting for the sale to open");
    // A dev node only moves its clock when it mines, so a rehearsal there jumps to the start.
    if (network === "localhost" || network === "hardhat") {
      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      if (now < params.startTime) {
        await hre.network.provider.send("evm_increaseTime", [Number(params.startTime - now) + 1]);
        await hre.network.provider.send("evm_mine", []);
      }
    }
    while (BigInt((await ethers.provider.getBlock("latest")).timestamp) < params.startTime) {
      process.stdout.write(".");
      await sleep(5000);
    }
    console.log("");
    const raised = await presale.totalRaised();
    if (raised < params.hardCap) {
      await send(`contributed ${ethers.formatEther(params.hardCap - raised)} ETH`, presale.contribute({ value: params.hardCap - raised }));
    }
    console.log("\n4. Finalizing: the Uniswap v4 pool opens now");
    await send("finalized", presale.finalize(0, 0));
    await send("tokens claimed", presale.claim());
  } else {
    console.log("\n3-4. The sale is already finalized");
  }

  const launch = await launcher.launchOf(tokenAddr);
  console.log(`  pool id ${launch.poolId}`);
  console.log(`  locked position #${launch.tokenId}, lock #${launch.lockId}`);

  const view = await lens.launchView(presaleAddr);
  console.log(`  price ${ethers.formatEther(view.currentPriceWei)} ETH, liquidity ${ethers.formatEther(view.liquidityWeth)} ETH, pool kind ${view.poolKind === 1n ? "Uniswap v4" : "V2"}`);

  // ------------------------------------------------------------ 5. trade

  console.log(`\n5. Buying ${ethers.formatEther(testBuy)} ETH of ${symbol} through the site's router`);
  const hookBefore = await ethers.provider.getBalance(d.v4Hook);
  const tokensBefore = await token.balanceOf(me.address);
  const deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
  await send("bought", router.buy(tokenAddr, 0, me.address, deadline, { value: testBuy }));
  const got = (await token.balanceOf(me.address)) - tokensBefore;
  const fee = (await ethers.provider.getBalance(d.v4Hook)) - hookBefore;
  console.log(`  received ${ethers.formatEther(got)} ${symbol}`);
  console.log(`  the hook took ${ethers.formatEther(fee)} ETH, ${((Number(fee) / Number(testBuy)) * 100).toFixed(2)}% of the buy (1% tax + 0.25% platform)`);

  // ---------------------------------------------------------- 6. fees on

  console.log("\n6. Sending the collected fees on");
  const reserveBefore = await treasury.buybackReserve();
  await send("creator share sent", hook.flush(launch.poolId));
  await send("platform share sent", hook.flushPlatform());
  const reserveAfter = await treasury.buybackReserve();
  console.log(`  Treasury buyback reserve grew by ${ethers.formatEther(reserveAfter - reserveBefore)} ETH`);

  console.log("\nDone. The first Uniswap v4 launch on HoodSale:");
  console.log(`  sale page   https://www.hoodsale.io/presale/${presaleAddr}`);
  console.log(`  token       ${addr(tokenAddr)}`);
  console.log(`  DexScreener https://dexscreener.com/robinhood/${launch.poolId}`);
  console.log(`  pool id     ${launch.poolId}   (the Uniswap hook allowlist form asks for this)`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
