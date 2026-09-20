import { describe, expect, it } from 'vitest';
import { parseAsianaOffers, type AsianaRow } from '../src/partners/asiana-award.js';

const row = (over: Partial<AsianaRow> = {}): AsianaRow => ({
  flight: 'OZ102 09:00 11:20', business: ' 22,500마일 ', radioId: 'radio11_1', cash: '100500.00', ...over,
});

describe('parseAsianaOffers', () => {
  it('reads the flight number and miles from the business column', () => {
    const [offer] = parseAsianaOffers([row()]);
    expect(offer.flightNumber).toBe('OZ102');
    expect(offer.soldOut).toBe(false);
    expect(offer.text).toBe('22,500마일 + 100,500원 (1인)');
  });

  it('states 매진 rather than inferring it from a missing price', () => {
    expect(parseAsianaOffers([row({ business: '매진' })])[0].soldOut).toBe(true);
    expect(parseAsianaOffers([row({ business: '선택 불가' })])[0].soldOut).toBe(true);
  });

  it('skips rows with no business column instead of shifting the rest', () => {
    const offers = parseAsianaOffers([
      row({ business: '   ', radioId: 'radio9_1' }),
      row({ flight: 'OZ108 19:00 21:20', radioId: 'radio12_1' }),
    ]);
    expect(offers).toHaveLength(1);
    expect(offers[0].flightNumber).toBe('OZ108');
    // The surviving offer must still point at its own row, not at position 0.
    expect(offers[0].radioId).toBe('radio12_1');
    expect(offers[0].index).toBe(1);
  });

  it('carries each offer its own radio, so a sold-out row is never the one held', () => {
    const offers = parseAsianaOffers([
      row({ business: '매진', radioId: 'radio11_1' }),
      row({ flight: 'OZ108 19:00', business: '30,000마일', radioId: 'radio12_1', cash: '120000.00' }),
    ]);
    const bookable = offers.filter((offer) => !offer.soldOut);
    expect(bookable).toHaveLength(1);
    expect(bookable[0].radioId).toBe('radio12_1');
    expect(bookable[0].text).toBe('30,000마일 + 120,000원 (1인)');
  });

  it('prints the miles alone when the fare data carries no cash amount', () => {
    expect(parseAsianaOffers([row({ cash: '' })])[0].text).toBe('22,500마일');
    expect(parseAsianaOffers([row({ cash: '0.00' })])[0].text).toBe('22,500마일');
    expect(parseAsianaOffers([row({ cash: undefined })])[0].text).toBe('22,500마일');
  });

  it('leaves the radio empty when the row carries none, so no wrong seat is held', () => {
    expect(parseAsianaOffers([row({ radioId: undefined })])[0].radioId).toBe('');
  });
});
