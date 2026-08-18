# Nike Catalog Service

An e-commerce product catalog: REST API with search, faceted filtering, carts,
checkout and accounts, plus a React storefront styled from Nike's own design language.

Node.js throughout. No database, no Docker requirement, no cloud account, no secrets to
provision — `npm install && npm run dev` and it runs.

---

## Quick start

```bash
npm install

npm run dev          # API on :3000
npm run dev:web      # storefront on :5173 (proxies /api -> :3000)

npm test             # 178 tests
npm run typecheck    # API + web
npm run build        # API -> dist/, plain JS on bare node
npm run db:reset     # discard the datastore; the catalog fixture is reinstalled
```

Run the two `dev` scripts in separate terminals. Vite proxies `/api`, so there is no
CORS configuration and no origin baked into the bundle.

With Docker:

```bash
docker compose up --build      # API on :3000, storefront on :8080
```

| Variable                              | Default               | Purpose                                                   |
| ------------------------------------- | --------------------- | --------------------------------------------------------- |
| `PORT`                                | `3000`                | API port                                                  |
| `API_KEY`                             | _(unset)_             | When set, catalog writes require it — or an admin session |
| `DATA_FILE`                           | `data/store.enc.json` | Encrypted datastore path                                  |
| `DATA_KEY`                            | _(committed default)_ | Datastore passphrase — see [Data at rest](#data-at-rest)  |
| `DEFAULT_PAGE_SIZE` / `MAX_PAGE_SIZE` | `20` / `100`          | Paging defaults and ceiling                               |

---

## Architecture

```
HTTP  ─►  routes ─►  service  ─►  repository  ─►  store
          parse,      business     interface      in-memory + encrypted file
          validate,   rules
          shape
```

```
src/
├── server.ts                  lifecycle, graceful shutdown, flush on exit
├── app.ts                     composition root
├── config.ts                  env read once, passed explicitly
├── domain/                    product · user · cart · errors
├── repositories/              interfaces + in-memory implementations
├── services/                  product · auth · cart · password
├── persistence/               encrypted store, database wiring
├── http/                      one routes + one schemas file per resource
└── seed/products.ts           38-product fixture
```

Four rules hold the layering together.

**Only `app.ts` knows which repository is real.** Everything else depends on an
interface. That seam is what makes the storage choice reversible.

**Only the HTTP layer knows about HTTP.** Services throw `NotFoundError`, not 404. One
middleware maps domain errors to status codes, so the same service could be driven by a
queue consumer or a CLI unchanged.

**Only the boundary touches untrusted input.** Zod parses bodies and query strings into
typed domain values. Every layer below assumes well-formed input. The decrypted
datastore counts as untrusted too, and is validated on load for the same reason.

**Filtering, sorting and pagination live in the repository, not the service.** A real
database must do that work in the query — you cannot load a million rows into Node to
filter them — so the in-memory implementation mirrors the contract a SQL one would have
to honour.

Routes and schemas are split per resource rather than pooled. The user is its own
resource with its own rules; burying a password policy among SKU and price validators
makes both harder to find.

---

## API

Base path `/api/v1`. Responses are `{ data }`; failures are `{ error }`.

| Method           | Path                                    | Purpose                                         |
| ---------------- | --------------------------------------- | ----------------------------------------------- |
| `GET`            | `/health` · `/ready`                    | Liveness · readiness                            |
| `GET`            | `/products`                             | Search, filter, sort, paginate                  |
| `GET`            | `/products/facets`                      | Filter-option counts for the current result set |
| `GET`            | `/products/:id`                         | Fetch one — returns an `ETag`                   |
| `GET`            | `/products/sku/:sku`                    | Fetch by SKU                                    |
| `POST`           | `/products`                             | Create                                          |
| `PATCH`          | `/products/:id`                         | Update — requires `If-Match`                    |
| `DELETE`         | `/products/:id`                         | Soft delete (status → `archived`)               |
| `POST`           | `/products/:id/variants/:sku/inventory` | Adjust stock by a signed delta                  |
| `POST`           | `/users`                                | Register                                        |
| `POST`           | `/users/sessions`                       | Sign in                                         |
| `DELETE`         | `/users/sessions/current`               | Sign out                                        |
| `GET`            | `/users/me`                             | Current user                                    |
| `PATCH`          | `/users/me/password`                    | Rotate password, revoking all sessions          |
| `GET` `DELETE`   | `/cart`                                 | Read · empty                                    |
| `POST`           | `/cart/items`                           | Add a variant, reserving stock                  |
| `PATCH` `DELETE` | `/cart/items/:variantSku`               | Set quantity (`0` removes) · remove             |
| `POST`           | `/cart/checkout`                        | Place an order — accepts `Idempotency-Key`      |
| `GET`            | `/cart/orders`                          | Order history                                   |

Authentication is modelled as operations on users, not a separate `/auth` area:
registering creates a user, signing in creates a session, signing out deletes it. The
alternative invents a resource that does not exist in the domain and leaves the User
model with no endpoints of its own.

### Query parameters

`q` `category` `brand` `gender` `size` `tags` `status` `minPrice` `maxPrice`
`inStockOnly` `sort` `page` `pageSize`

Multiple values of one filter are OR-ed; different filters are AND-ed. So
`category=Running,Training&brand=Nike` means _(Running OR Training) AND Nike_ — what a
shopper expects from a faceted catalog. `tags` is the deliberate exception and is AND-ed.

Unknown parameters are **rejected with 400** rather than ignored. A typo'd
`?categoryy=Running` that silently returns the whole catalog is worse than an error.

`status` defaults to `active`, so drafts and archived products never leak into a public
listing by accident.

```bash
curl "localhost:3000/api/v1/products?category=Running&inStockOnly=true&sort=price:asc"
curl "localhost:3000/api/v1/products/facets?category=Running"
```

### Errors

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "price.amount", "message": "must be an integer" }],
    "requestId": "8a48142a-..."
  }
}
```

`VALIDATION_ERROR` 400 · `UNAUTHORIZED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 ·
`CONFLICT` / `INSUFFICIENT_STOCK` 409 · `PRECONDITION_FAILED` 412 ·
`PRECONDITION_REQUIRED` 428 · `RATE_LIMITED` 429 · `INTERNAL_ERROR` 500

Validation reports every failure at once, not just the first — a client fixing a form
shouldn't need six round trips. Unexpected errors log a stack server-side and return a
bare 500; internals never reach the client. Every response carries `x-request-id`,
which also appears in the error body and the access log.

---

## Design decisions

### Money is an integer in the minor unit

₹13,295.00 is stored as `1329500` paise. Floats accumulate representation error under
arithmetic, so `19.999` is rejected at the boundary rather than discovered at checkout.
`formatMoney` defaults to `en-IN` because Indian numbering groups by lakh —
`₹1,50,000.00`, not `₹150,000.00`.

_Limit:_ dividing by 100 assumes a 2-decimal minor unit. True for INR and USD, wrong
for zero-decimal currencies like JPY.

### Inventory lives on the variant

Stock is a property of _this shoe in size 9_, not of the shoe. Modelling it on the
product would make the API unable to express the most common catalog state: in stock,
but not in your size.

### Inventory moves by signed delta, never absolute

`{"delta":-1}`, not `{"inventory":6}`. Two simultaneous reservations correctly leave
stock at N−2, whereas two clients that each read N and write N−1 lose one decrement.

### Carts hold references; orders hold prices

The stored cart is ids and quantities only. Prices and names resolve from the catalog on
every read, so a repricing is reflected immediately and a cart can never quote a stale
figure. Orders are the opposite: `OrderLine` captures its own `unitPrice`, because an
order must record what the customer agreed to pay even if the catalog changes tomorrow.

### Stock is reserved on add, with a TTL

Two shoppers each adding the last pair should not both reach payment, so entering a cart
places a 15-minute hold. The TTL is the interesting part: a permanent reservation means
one abandoned cart strands that pair forever and a popular size quietly becomes
unbuyable. Holds are separate records from cart lines, because a cart is long-lived and
a reservation is not — when a hold expires the line stays and simply reports that it can
no longer be fulfilled. Your bag keeps its contents; you can lose your claim on scarce
stock.

A shopper's own hold is not counted against them, or their cart would appear to compete
with itself. Expiry is lazy, evaluated when availability is next read, rather than run
from a timer that would keep the process awake and need supervising.

### Checkout is idempotent and self-compensating

`Idempotency-Key` makes a retry safe: a repeat returns the original order instead of
placing a second one, which is the fix for a double-clicked Pay button or a client
retrying after a timeout it could not distinguish from success. The idempotency lookup
runs _before_ the empty-cart check, because a successful checkout empties the cart — so
the canonical retry arrives with an empty cart, and checking that first would answer it
with "cannot check out an empty cart". A reused key describing a genuinely different
basket is a 409, since replaying the old order would hide a real client bug.

Inventory deltas are applied one line at a time and reversed if a later line fails.
Without that, a cart whose third line is out of stock would leave the first two silently
decremented.

_This is a compensating action, not a transaction._ It is not atomic under concurrency —
another request can interleave between awaits. On Postgres the whole method becomes one
`BEGIN … COMMIT` with `UPDATE … SET inventory = inventory - $1 WHERE inventory >= $1`,
and the compensation logic gets deleted.

### Updates require `If-Match`

`GET /products/:id` returns an ETag; `PATCH` requires it back. Two editors who both
loaded version A would otherwise each write, and the second would silently erase the
first. The header is **required**, not optional: optional means the unsafe path is the
default and every client that forgets gets last-write-wins without being told.
`If-Match: *` is an explicit opt-out.

The ETag is a content hash rather than a version counter. It needs no extra field, two
edits in the same millisecond still differ where a timestamp would collide, and two
identical states correctly produce the same tag.

### Soft delete

`DELETE` sets `status: archived`. Catalog rows are referenced by orders, analytics and
search indexes; hard-deleting orphans that history.

### Sorting always tie-breaks on id

Without it, two products at the same price can swap places between page 1 and page 2, so
a user scrolling sees one item twice and misses another.

### Rate limiting is a sliding window, in process

Sign-in is the tightest limit for two compounding reasons: it is the credential-stuffing
target, and password verification runs scrypt at ~57 ms of deliberately memory-hard
work. An unthrottled sign-in is therefore also a CPU exhaustion vector — a few hundred
concurrent attempts starve the event loop whether or not any credential is guessed. It
is keyed on IP _and_ email, so one attacker cannot lock out a shared NAT.

Sliding rather than fixed windows: a fixed window lets a caller fire the full quota at
0.99 s and again at 1.01 s, passing two windows while delivering double the burst.

_Limit:_ counters are per-process, so N replicas allow N times the rate and a restart
forgives everyone. A real deployment needs a shared store; `RateLimitStore` is that seam.

Health and readiness are never throttled — rate limiting a health check is how a busy
service gets itself depooled.

---

## Authentication

**Passwords use scrypt** (N=32768, r=8, p=1) with a unique random salt each. scrypt is
memory-hard, so GPU attacks are expensive; a salted SHA-256 is not acceptable for
credentials. Cost parameters live inside the hash string (`scrypt$N$r$p$salt$hash`), so
they can be raised later without invalidating existing hashes, and a hash below current
policy is transparently upgraded on next sign-in. Comparison is `timingSafeEqual` —
string equality short-circuits on the first differing byte, and that timing is
measurable.

**Sessions are opaque 256-bit tokens, stored hashed.** The server keeps only a SHA-256
of the token, so a dumped session table cannot be replayed as credentials. SHA-256 is
correct here, unlike for passwords: a high-entropy random token has no structure to
brute-force, so memory-hard hashing would only add latency to every request.

**Account enumeration is treated as real.** Sign-in returns one message for both unknown
email and wrong password — and when the email is unknown it still computes a hash against
a dummy value, so response time matches. Without that, latency alone distinguishes
registered addresses and the shared message achieves nothing. Registration does reveal
that an address is taken: it genuinely cannot proceed, and a generic error would leave
the user stuck.

**Roles.** `customer` and `admin`. Registration cannot self-assign a role — the schema is
`.strict()`, so `{"role":"admin"}` is rejected outright rather than silently dropped.
Catalog writes accept an API key (machine callers) or an admin session (humans). A
signed-in customer attempting one gets **403, not 401**: we know who they are, so telling
them to re-authenticate cannot help.

**The token is returned in the body, not a cookie.** That sidesteps CSRF entirely, since
a cross-site request cannot read a body. The cost is that the client stores it and
`localStorage` is readable by any XSS. The stronger design is an httpOnly, Secure,
SameSite refresh cookie plus a short-lived in-memory access token — a deliberate
simplification, recorded rather than pretended away.

---

## Data at rest

All state — products, users, sessions, carts, orders, holds, idempotency records — lives
in one AES-256-GCM encrypted file, committed to the repository. The repositories are the
in-memory source of truth for reads; the file is a write-behind mirror refreshed on a
250 ms debounce, so request latency never includes a disk write.

### What the encryption actually buys you

Worth being blunt, because it is easy to oversell. The data file is in the repo and by
default so is the passphrase. Anyone with the repo has both. **That is not
confidentiality against someone who can read the repository.**

What it does provide:

- **Tamper detection.** GCM is authenticated encryption; change one byte and startup
  fails loudly instead of loading altered records.
- **Opacity at rest.** Emails and order history are not sitting in plaintext to be
  grepped or read in a diff. The file is written `0600`.
- **Real confidentiality when `DATA_KEY` is set** and not committed. That is the intended
  production posture, and the server warns while the default is in use.

The load-bearing protection for the most sensitive field is elsewhere: passwords are
scrypt-hashed _before_ they reach the file, so decrypting it yields no usable
credentials.

### Durability

Writes go to a temp file and are then `rename`d, because a crash mid-write would
otherwise leave a truncated file that fails its auth tag — losing everything. `SIGTERM`
flushes before exit, since a debounced write acknowledged in the last 250 ms would
otherwise be lost. A decryption failure **refuses to start**: coming up empty would look
like data loss and would then overwrite the good file with that empty state on the first
write, turning a recoverable key mistake into a permanent one.

Products are persisted rather than re-seeded, because checkout decrements inventory and
re-seeding would resurrect sold stock and leave orders contradicting the catalog.

---

## Storefront

React 19 + Vite, styled from Nike's live design language rather than from taste. The
tokens in `web/src/styles/tokens.css` were extracted from `nike.com` with Firecrawl:
`#FFFFFF` canvas, `#111111` ink (never pure black), `#707072` secondary, `#F5F5F5` media
tiles, pill buttons at `30px`, a 4 pt base unit, and **zero shadows** — Nike's CSS
reports no elevation on any component, and matching that is most of why this reads as
Nike rather than as a generated dashboard.

**Fonts are substituted, and it matters.** Nike uses Helvetica Now Text and Display,
proprietary Monotype faces that cannot be redistributed. The `nike.com/in` stack lists
Inter as a fallback, so this ships Inter Tight + Inter: the same neo-grotesque skeleton,
open-licensed. The Swoosh is a Nike trademark, reproduced here for an interview exercise
— do not deploy this publicly.

**Product imagery is generated, not stubbed.** The fixture's image URLs do not resolve,
so rather than ship broken `<img>` tags or invent stock photography, each card draws a
tile on Nike's real `#F5F5F5` product-tile grey, tinted from the product's own colourway
and rotated through five hard-edged compositions keyed off the product id. One repeated
shape across a 24-tile grid reads as a template no matter how the colour varies. Point
`images` at a real CDN and photography replaces it with no code change.

No invented social proof: no review counts, no star ratings, no "trusted by 50,000
athletes". Stock warnings quote the real number from the API.

**No optimistic cart updates.** Every mutation returns the recomputed cart and replaces
local state. The server is the only thing that knows current stock, so an optimistic add
would sometimes need a visible rollback; for a cart, a brief spinner beats a flickering
wrong number.

**The idempotency key is held per checkout attempt**, so a retry after a network failure
reuses it. Minting a fresh key on retry would make the server treat it as a new order.

**Responsiveness.** No feature is removed to fit a viewport — the nav wraps rather than
scrolling out of sight, and the filter rail becomes an off-canvas sheet below 1024 px but
stays reachable. Column count comes from `repeat(auto-fill, minmax(min(16rem, 100%),
1fr))`, so it tracks width rather than snapping at breakpoints, and headings use
`clamp()` with Nike's observed size as the ceiling. Verified with a scripted sweep across
twelve viewport sizes, including deliberately short windows, that walks each element's
scroll ancestors to detect content clipped by an overflow container rather than merely
absent.

---

## Continuous integration

Five jobs, ordered so the cheapest failures surface first.

| Job | What it proves |
| --- | --- |
| `static` | Types compile (API + web), lint passes, formatting is clean |
| `unit` | 178 tests on Node 22 and 24, with coverage |
| `build` | Artifacts exist **and** the compiled JS boots on bare `node` and reaches ready |
| `smoke` | A real server over a real socket: purchase flow, idempotent replay, session revocation |
| `docker` | Both images build, then the composed stack is smoke-tested *through nginx* |

The `build` job asserts `dist/server.js` exists rather than trusting the exit code, since
a build that emits nothing still exits 0. The `docker` job smoke-tests through the proxy
rather than hitting the API directly, so a broken proxy path fails in CI instead of in
front of a reviewer.

Smoke tests are deliberately separate from the unit suite. Unit and integration tests
drive the app in-process with injected repositories, which cannot catch anything about the
deployed artifact — a broken entry point, a datastore that will not decrypt, an env var
never wired through. `npm run smoke` runs them against any base URL.

---

## Testing

178 tests. `npm test`.

Two layers, deliberately. Service tests drive business rules through the repository
interface with no HTTP, proving they hold independently of transport. API tests drive the
real Express app in-process via supertest; `createApp()` binds no port, so each test
builds its own app and freshly seeded repositories and they run in parallel with no
shared state.

Expected counts are **derived from the seed**, not hard-coded. `expect(total).toBe(4)` is
a fact about the fixture, not the filtering logic, and it turns every catalog edit into a
false failure. Growing the seed from 12 to 38 products needed no test rewrites.

The security-relevant properties get direct tests, because they fail silently: no
plaintext reaches the datastore, a flipped ciphertext byte is detected, a fresh salt and
IV are used per write (nonce reuse under GCM is catastrophic), the two sign-in failure
modes are indistinguishable, `{"role":"admin"}` is rejected, a password change revokes
every session, a stale `If-Match` cannot clobber a newer write, a replayed idempotency
key moves stock once, and one user can neither see nor mutate another's cart.

---

## Tradeoffs

**In-memory repositories with an encrypted file mirror, not Postgres.** The deciding
constraint was that a clean clone must run with no services to provision. The costs are
real: no cross-process sharing, per-process rate-limit counters, non-atomic checkout, and
search quality capped at weighted term matching.

`ProductRepository` keeps it reversible — migrating means writing one class:

| Concern    | Now                   | Postgres                              |
| ---------- | --------------------- | ------------------------------------- |
| Filtering  | `Array.filter`        | `WHERE` + partial indexes             |
| Search     | Weighted term match   | `tsvector` / `ts_rank`, or OpenSearch |
| Facets     | Recount per request   | `GROUP BY`, or a cached rollup        |
| Inventory  | Rebuild the array     | `UPDATE … WHERE inventory >= $1`      |
| Pagination | `slice`               | `LIMIT`/`OFFSET`, then keyset         |
| Checkout   | Compensating reversal | One transaction                       |

**Offset pagination, not cursor.** Offset is what a numbered storefront pager needs and
is honest about `totalPages`. It degrades on deep pages and can skip items if the catalog
mutates mid-scroll; keyset on `(sort_key, id)` is the fix, and the existing id tie-break
is already the stable key it needs.

**Search relevance is deliberately simple.** Weighted field matching with AND semantics
across terms. No stemming, no fuzzy matching: `runing` returns nothing. Real relevance
belongs in Postgres full-text search or OpenSearch, not application code.

**No tax or shipping line.** Both are real business rules that vary by destination.
Fabricating a percentage would make the total a lie, so the cart shows a subtotal.

**One `package.json` for API and web.** Simpler for a reviewer to clone and run than
workspaces. A real repo would split them so the front end cannot import server code.

---

## What I'd do next

1. **Postgres behind the existing interface** — real transactions, `tsvector` search,
   keyset pagination, and the compensation logic deleted.
2. **Shared rate-limit store** so limits hold across replicas.
3. **OpenAPI generated from the Zod schemas**, with a typed client for the front end —
   which would delete the hand-maintained wire types and the duplicated `MAX_QUANTITY`.
4. **httpOnly refresh cookie + in-memory access token**, so an XSS cannot walk off with a
   seven-day session.
5. **Payment boundary** — the current checkout moves stock but takes no money; a real one
   needs a payment intent whose success and inventory commit cannot diverge.
6. **Observability** — OpenTelemetry traces and structured logs, reusing the existing
   request id as the correlation key.

---

## Retargeting to another domain

`src/domain/product.ts` and the seed carry essentially all the catalog knowledge; the
query, pagination, faceting, error and HTTP machinery is generic. Pointing this at a
Backstage-style service catalog maps over almost exactly: `category` → `lifecycle`,
`brand` → `owning team`, `variants` → `deployed environments`, `inStock` → `healthy`.
The filter/facet/sort/paginate surface is the same problem.
