import { describe, expect, it } from 'vitest';
import { loginUrl, signedIn, LOGIN_PAGE } from '../src/sas/login-page.js';

const ASIANA_SEARCH = 'https://flyasiana.com/I/KR/KO/MileageSeatSearch.do';
const ASIANA_LOGIN = 'https://flyasiana.com/I/KR/KO/viewLogin.do?callType=IBE&menuId=CM201802220000728453';
const KOREAN_AIR_BOOKING = 'https://www.koreanair.com/booking/search?bookingType=A&tripType=OW';

describe('where signing in happens', () => {
  it('sends Asiana to its login page, not its public search page', () => {
    // Asiana's mileage seat search is public: opening it to "log in" shows a search
    // form, and probing it for a session answers yes even when signed out.
    expect(loginUrl('asiana-club', ASIANA_SEARCH)).toBe(ASIANA_LOGIN);
    expect(loginUrl('asiana-club', ASIANA_SEARCH)).not.toBe(ASIANA_SEARCH);
  });

  it('leaves Korean Air on its booking page, which redirects to login by itself', () => {
    expect(loginUrl('korean-air', KOREAN_AIR_BOOKING)).toBe(KOREAN_AIR_BOOKING);
  });

  it('has no opinion about a program it does not know', () => {
    expect(loginUrl('sas-eurobonus', undefined)).toBeUndefined();
  });
});

describe('telling a signed-out session from a signed-in one', () => {
  it('reads Asiana sitting on its own login page as signed out', () => {
    expect(signedIn(ASIANA_LOGIN)).toBe(false);
  });

  it('reads Korean Air sent to a login page as signed out', () => {
    expect(signedIn('https://www.koreanair.com/kr/ko/login?redirect=%2Fbooking')).toBe(false);
  });

  it('reads having left the login page as signed in', () => {
    expect(signedIn(ASIANA_SEARCH)).toBe(true);
    expect(signedIn(KOREAN_AIR_BOOKING)).toBe(true);
  });

  it('does not depend on the airline capitalising its login path', () => {
    expect(signedIn('https://flyasiana.com/I/KR/KO/viewlogin.do')).toBe(false);
    expect(signedIn('https://www.koreanair.com/Login')).toBe(false);
  });

  it('is a shared rule, so both airlines are judged the same way', () => {
    expect(LOGIN_PAGE.test(ASIANA_LOGIN)).toBe(true);
    expect(LOGIN_PAGE.test(ASIANA_SEARCH)).toBe(false);
  });
});
