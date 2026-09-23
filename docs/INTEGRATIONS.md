# Externa beroenden – status (kontrollerat 2026-09-23)

Statusnycklar: **VERIFIED** = bekräftat mot aktuell officiell dokumentation · **UNVERIFIED** = rimligt men ej bekräftat i detalj, måste valideras i sandbox · **BLOCKED** = ej tillgängligt för oss nu · **NEEDS OWNER ACTION** = kräver dig.

## Amazon (SP-API, Seller Central Europe)

| Del | Status | Detalj |
|---|---|---|
| Dropshipping-policy | VERIFIED | Du måste vara *seller of record*; ingen annan får synas på följesedel, faktura eller förpackning; du tar emot och hanterar returer. Att köpa från annan återförsäljare som skickar direkt är förbjudet. Implementerat som hårda block i `domain/compliance.ts` (retailer-leverantör, ej blind dropship). |
| Auth: LWA refresh token, header `x-amz-access-token` (ingen AWS SigV4) | VERIFIED | `integrations/amazon/spapi.ts` |
| SP-API-avgifter ($1 400/år + GET-avgifter) | VERIFIED – **inställt** | Aviserat nov 2025, skjutet upp, helt dragit tillbaka 12 maj 2026. Inga avgifter i dag. |
| Orders API v0 | VERIFIED – utfasas | Deprecated 2026-01-28, **tas bort 2027-03-27**. Adaptern använder v0 i dag. |
| Orders API v2026-01-01 | UNVERIFIED (paths/params) | Ny version, ett anrop hämtar all orderdata, PII utan Tokens API. Migrering måste ske före 2027-03-27 (TODO(ORDERS_V2026)). |
| Listings Items 2021-08-01 (PUT/PATCH pris+lager) | UNVERIFIED payload | Används för offer-only på befintlig ASIN (föredras) och pris/antal. Valideras i SP-API sandbox. |
| Product Pricing 2022-05-01 `competitiveSummary` (batch 20) | UNVERIFIED payload | Konkurrentpris / Buy Box. |
| Product Fees v0 `getMyFeesEstimate` | UNVERIFIED payload | För att verifiera avgiftstabellen (startvärde 15 %, konservativt). |
| Reports API `GET_V2_SELLER_PERFORMANCE_REPORT` | UNVERIFIED schema | Account health (ODR, LSR, cancel, VTR). Systemet räknar dessutom egna tidiga varningsvärden från databasen. |
| Tokens API (RDT) för leveransadress | VERIFIED koncept | Adress hämtas just-in-time, lagras inte (GDPR). |
| Marketplace-ID: SE `A2NODRKZP88ZB9`, DE `A1PA6795UKMFR9` m.fl. | UNVERIFIED | Från SP-API-dokumentationen; bekräftas vid appregistrering. |
| Amazon.se avgifter | VERIFIED (sell.amazon.se) | Professional-plan 410 SEK/mån exkl. moms; referral fee de flesta kategorier 15 %, vissa lägre (Hem 8 % upp till 230 SEK). |
| Account health-gränser | VERIFIED (sekundära källor) | Amazon: ODR < 1 %, LSR < 4 %, cancel < 2,5 %, VTR > 95 %. Systemet pausar redan vid 0,5 / 2 / 1,5 / 97. |
| Kontot | NEEDS OWNER ACTION | Professional-konto på Seller Central Europe, identitetsverifiering, utvecklarregistrering, självauktorisering. |

## eBay

| Del | Status | Detalj |
|---|---|---|
| Dropshipping-policy | VERIFIED (help id=4176) | Tillåtet från *grossist*. Förbjudet: köpa från annan återförsäljare/marknadsplats som skickar direkt till kunden. Blockeras i compliance. |
| Finding API & Shopping API | VERIFIED – **nedlagda** 2025-02-04 | Ersatta av Browse API (används för konkurrentpriser via GTIN). |
| Product API | VERIFIED – nedlagt 2026-08-15 | Använd Catalog/Metadata API. |
| `UploadSiteHostedPictures` (Trading) | VERIFIED – nedläggs 2026-09-30 | Bilder via Media API / egna URL:er. |
| Post-Order API | VERIFIED delvis nedlagt | Många return/case-metoder togs bort jan–mars 2026. Returer läses därför inte automatiskt ännu (UNVERIFIED ersättare) – eskaleras. |
| Sell Inventory / Fulfillment / Analytics (seller standards) | UNVERIFIED payload | Implementerat i `integrations/ebay/ebay.ts`; valideras i eBay sandbox. |
| Marketplace Account Deletion-notifiering | VERIFIED krav | Endpoint `/webhooks/ebay/account-deletion` finns (challenge = SHA-256(code+token+endpoint)). |
| EBAY_SE | VERIFIED | Finns som MarketplaceId (ebay.com/sch/Sweden) men ingen full svensk sajt → **EBAY_DE är primär EU-marknad**. |
| eBay-säljarkonto (företag) + business policies | NEEDS OWNER ACTION | |

## Marknadsdata

| Källa | Status | Detalj |
|---|---|---|
| Keepa API | VERIFIED | Pris/rank-historik, Product Finder, Best Sellers. 1 token/ASIN. **Stöder inte amazon.se/.nl/.pl** – amazon.de används som EU-proxy, SE-pris kontrolleras via SP-API. Plan/pris: NEEDS OWNER ACTION (köp plan). |
| Keepa fältindex (stats.current[3] osv.) | UNVERIFIED | Valideras vid första körning. |
| Google Trends API (alpha) | BLOCKED tills ansökan godkänts | Officiellt alpha-program med ansökan. Trendkomponenten använder neutralt värde tills dess. Skrapning av Google Trends används **inte**. |
| eBay Marketplace Insights (sålda objekt) | BLOCKED | Limited release, kräver godkännande. |
| Amazon Brand Analytics | BLOCKED | Kräver Brand Registry. |
| ECB referenskurser (SEK) | VERIFIED | Gratis, officiell, daglig. |

## Leverantörer (grossister med API, EU-lager)

| Leverantör | Status | Detalj |
|---|---|---|
| **BigBuy** (Spanien) | VERIFIED: REST-API för katalog, lager, order, frakt, tracking + sandbox. UNVERIFIED: exakta endpoints/fält, blind-dropship-flagga, pris för "Pack Marketplace" (~€119/mån enl. tredjepart). | Förstaval i adaptern. Kräver avtal + verifiering (NEEDS OWNER ACTION). |
| vidaXL / dropXL (NL) | UNVERIFIED | Gratis registrering, 150 000+ produkter, EU-lager, WooCommerce-plugin. Katalogen säljs redan brett på Amazon → hög konkurrens. Villkor för försäljning på Amazon/eBay måste kontrolleras. Adapter ej byggd. |
| CJdropshipping (API v2) | UNVERIFIED | API finns; främst kinesiska lager med vissa EU-lager. Leveranstid och GPSR-data måste kontrolleras per SKU; hålls som reserv. |

Ingen leverantör kan användas förrän du i dashboarden intygat: avtal signerat, blind dropship (du som seller of record), företagsuppgifter kontrollerade.

## Källor
- SP-API deprecations: https://developer-docs.amazon.com/sp-api/docs/sp-api-deprecations
- Orders API v2026-01-01: https://developer-docs.amazon.com/sp-api/changelog/new-introducing-the-orders-api-v2026-01-01
- SP-API-avgifter inställda: https://novadata.io/resources/news/amazon-sp-api-subscription-fees-2026 , https://ppc.land/amazon-drops-sp-api-fees-after-developer-pushback/
- Amazon.se priser: https://sell.amazon.se/en/priser
- Amazon dropshipping-policy (forumcitat av policyn): https://sellercentral.amazon.com/seller-forums/discussions/t/673fc46fa652feabf550e10375452fbc
- eBay dropshipping: https://www.ebay.com/help/selling/posting-items/setting-postage-options/drop-shipping?id=4176
- eBay API deprecation status: https://developer.ebay.com/develop/get-started/api-deprecation-status
- eBay Q2 2026 newsletter: https://developer.ebay.com/updates/newsletter/q2_2026
- eBay MarketplaceIdEnum: https://developer.ebay.com/api-docs/sell/fulfillment/types/ba:MarketplaceIdEnum
- Keepa API: https://keepa.com/api-docs/ , https://keepa.com/api-docs/product.html
- Google Trends API alpha: https://developers.google.com/search/apis/trends
- BigBuy API: https://www.bigbuy.eu/en/api_bigbuy.html , https://www.bigbuy.eu/en/synchronisation.html
