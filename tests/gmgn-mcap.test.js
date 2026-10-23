import test from 'node:test';
import assert from 'node:assert/strict';

import { marketCapFromGmgn, tokenPriceFromGmgn } from '../src/utils.js';

// GMGN frontend-api token payload shape: `price` is an OBJECT keyed by window.
const livePayload = {
  address: 'G9wFzt1XqToHN64yrVae5JxFfY9v4K9w7quJ6zXpump',
  circulating_supply: '999632984.845631',
  total_supply: '999632984.845631',
  liquidity: '258643.70098415387',
  price: {
    address: 'G9wFzt1XqToHN64yrVae5JxFfY9v4K9w7quJ6zXpump',
    price: '0.0093186212',
    price_1m: '0.00931',
    buys_1m: 3,
    volume_24h: '90530.0064760343',
  },
};

test('nested GMGN price object is unwrapped for spot price', () => {
  assert.equal(tokenPriceFromGmgn(livePayload), 0.0093186212);
});

test('market cap derives from nested price x circulating supply', () => {
  const mcap = marketCapFromGmgn(livePayload);
  assert.ok(Math.abs(mcap - 9_315_201) < 100, `unexpected mcap ${mcap}`);
});

test('top-level market_cap wins when GMGN provides it', () => {
  assert.equal(marketCapFromGmgn({ market_cap: 123456, price: { price: '1' } }), 123456);
});

test('flat numeric price still works', () => {
  assert.equal(tokenPriceFromGmgn({ price: 0.5 }), 0.5);
});

test('migration_market_cap is the last-resort mcap source', () => {
  assert.equal(marketCapFromGmgn({ migration_market_cap: 42000 }), 42000);
});

test('missing price never returns NaN', () => {
  assert.equal(tokenPriceFromGmgn({}), null);
  assert.equal(marketCapFromGmgn({ circulating_supply: '1000' }), null);
  assert.equal(tokenPriceFromGmgn(null), null);
});

test('zero/negative nested price is rejected', () => {
  assert.equal(tokenPriceFromGmgn({ price: { price: '0' } }), null);
  assert.equal(tokenPriceFromGmgn({ price: { price: '-1' } }), null);
});
