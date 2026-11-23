# EQUIPMENT Unique

LIFF app for borrowing and returning Survey equipment (Unique, BPNP project) through LINE.

- LIFF URL: https://liff.line.me/2012756966-P652TGXb
- Hosting: GitHub Pages (`index.html` in this repo)
- Backend: Google Apps Script web app (`gas/Code.gs`) with data in Google Sheets
- No secrets, employee data or equipment data live in this repo. The LINE channel access token is kept in Apps Script Script Properties.

## Pages

| Link | Opens |
|---|---|
| `?v=borrow` | Borrow (scan QR / type a code) |
| `?v=return` | Return |
| `?v=mine` | My tickets |
| `?v=admin` | Admin overview (ADMIN / CHECKER) |
| `?c=<asset code>` | QR on equipment labels |
| `?t=<ticket id>` | QR on a ticket |
