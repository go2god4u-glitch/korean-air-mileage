/** Where signing in happens, and how to tell that it has not.
 *
 * Searching and signing in are different pages, and conflating them is how the app
 * came to report a signed-out Asiana account as signed in. Asiana's mileage seat
 * search is public: opening it to "log in" shows a search form, and probing it for
 * a session always answers yes. Korean Air's award booking page redirects to its
 * login instead, so it doubles as its own probe and needs no entry here.
 */
export const LOGIN_URLS: Record<string, string> = {
  'asiana-club': 'https://flyasiana.com/I/KR/KO/viewLogin.do?callType=IBE&menuId=CM201802220000728453',
  'star-alliance': 'https://flyasiana.com/I/KR/KO/viewLogin.do?callType=IBE&menuId=CM201802220000728453',
};

/** Landing here means signed out, whichever airline it is: Asiana stays on its own
 *  login page, Korean Air is sent to one. */
export const LOGIN_PAGE = /viewLogin|\/login/i;

export function loginUrl(program: string, searchUrl?: string): string | undefined {
  return LOGIN_URLS[program] ?? searchUrl;
}

export function signedIn(url: string): boolean {
  return !LOGIN_PAGE.test(url);
}
