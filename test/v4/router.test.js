const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployPlatformV4, taxConfig } = require("./helpers");

const E = ethers.parseEther;
const FEE = E("0.1");
const DAY = 86400n;
const Lock = 0;
const Tax = 1;

describe("V4 router", function () {
  async function launched() {
    const ctx = await deployPlatformV4();
    const { launcher, presaleFactory, alice, bob, carol, marketing } = ctx;
    const now = BigInt(await time.latest());
    const start = now + 1000n;

    await launcher.connect(alice).createToken(
      Tax,
      { name: "Trade", symbol: "TRD", totalSupply: E("1000000"), rewardToken: ethers.ZeroAddress },
      taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 500 }),
      alice.address
    );
    const created = await launcher.tokensOfCreator(alice.address);
    const tokenAddr = created[created.length - 1];
    const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);

    const params = {
      token: tokenAddr,
      presaleRate: E("1000"),
      listingRate: E("800"),
      softCap: E("5"),
      hardCap: E("10"),
      minContribution: E("0.1"),
      maxContribution: E("5"),
      startTime: start,
      endTime: start + DAY,
      liquidityBps: 6000,
      liquidityAction: Lock,
      lockDuration: 30n * DAY,
      launchTime: 0,
      whitelistEnabled: false,
    };
    await token.connect(alice).approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.connect(alice).createPresale(params, { value: FEE });
    const presale = await ethers.getContractAt(
      "Presale",
      await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n)
    );
    await time.increaseTo(start);
    await presale.connect(bob).contribute({ value: E("5") });
    await presale.connect(carol).contribute({ value: E("5") });
    await presale.connect(alice).finalize(0, 0);
    await presale.connect(bob).claim();
    return { ...ctx, token, tokenAddr, presale };
  }

  const deadline = async () => (await time.latest()) + 600;

  it("buys the token with ETH and charges the pool's tax", async function () {
    const { v4Router, hook, token, tokenAddr, dave } = await loadFixture(launched);
    const spend = E("1");
    const before = await ethers.provider.getBalance(dave.address);
    const receipt = await (
      await v4Router.connect(dave).buy(tokenAddr, 0, dave.address, await deadline(), { value: spend })
    ).wait();

    expect(before - (await ethers.provider.getBalance(dave.address)) - receipt.fee).to.equal(spend);
    expect(await token.balanceOf(dave.address)).to.be.greaterThan(0);
    // 0.25% platform plus 3% marketing.
    expect(await ethers.provider.getBalance(hook.target)).to.equal((spend * 325n) / 10_000n);
    expect(await ethers.provider.getBalance(v4Router.target)).to.equal(0);
  });

  it("sells the token back for ETH", async function () {
    const { v4Router, token, tokenAddr, bob, carol } = await loadFixture(launched);
    const amount = E("1000");
    await token.connect(bob).approve(v4Router.target, amount);
    const before = await ethers.provider.getBalance(carol.address);
    await v4Router.connect(bob).sell(tokenAddr, amount, 0, carol.address, await deadline());

    expect((await ethers.provider.getBalance(carol.address)) - before).to.be.greaterThan(0);
    expect(await ethers.provider.getBalance(v4Router.target)).to.equal(0);
    expect(await token.balanceOf(v4Router.target)).to.equal(0);
  });

  it("refuses a swap that falls short of the minimum or arrives late", async function () {
    const { v4Router, tokenAddr, dave } = await loadFixture(launched);
    await expect(
      v4Router.connect(dave).buy(tokenAddr, E("1000000"), dave.address, await deadline(), { value: E("1") })
    ).to.be.revertedWithCustomError(v4Router, "TooLittleReceived");
    await expect(
      v4Router.connect(dave).buy(tokenAddr, 0, dave.address, (await time.latest()) - 1, { value: E("1") })
    ).to.be.revertedWithCustomError(v4Router, "Expired");
  });

  it("refuses a token that has not launched here", async function () {
    const { v4Router, weth, dave } = await loadFixture(launched);
    await expect(
      v4Router.connect(dave).buy(weth.target, 0, dave.address, await deadline(), { value: E("1") })
    ).to.be.revertedWithCustomError(v4Router, "NotLaunched");
  });

  it("quotes a buy through Uniswap's own quoter, tax included", async function () {
    const { quoter, launcher, tokenAddr, v4Router, dave } = await loadFixture(launched);
    const key = await launcher.poolKeyOf(tokenAddr);
    const spend = E("1");
    const quoted = await quoter.quoteExactInputSingle.staticCall({
      poolKey: [key[0], key[1], Number(key[2]), Number(key[3]), key[4]],
      zeroForOne: true,
      exactAmount: spend,
      hookData: "0x",
    });
    const out = await v4Router
      .connect(dave)
      .buy.staticCall(tokenAddr, 0, dave.address, await deadline(), { value: spend });
    // The quoter runs the real swap, so its answer already has the hook's cut taken out.
    expect(out).to.equal(quoted[0]);
  });
});
