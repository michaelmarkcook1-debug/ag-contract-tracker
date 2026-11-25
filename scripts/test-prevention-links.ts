import assert from "node:assert/strict";
import { preferredArticleSource, preferredPublicArticleSource } from "../src/lib/source-authority";

const bosch = {
  sourceUrl: "https://www.tcs.com/news/tcs-bosch-five-year-it-modernisation",
  sourceTitle: "TCS signs five-year IT modernisation deal with Bosch",
  sourceType: "company_press_release",
};
const porsche = {
  sourceUrl: "https://www.tcs.com/news/tcs-porsche-ai-powered-mobility",
  sourceTitle: "TCS and Porsche sign strategic partnership for AI-powered mobility",
  sourceType: "company_press_release",
};
const context = {
  referenceTitle: "TCS | NEW_WIN | Porsche | Five-year IT modernisation",
  providerName: "TCS",
  counterpartyNames: ["Porsche"],
};
for (const choose of [preferredArticleSource, preferredPublicArticleSource]) {
  assert.equal(choose([bosch], bosch.sourceUrl, "https://tcs.com", context), null,
    "A canonical URL must not bypass the Porsche/Bosch identity check");
  assert.equal(choose([bosch, porsche], bosch.sourceUrl, "https://tcs.com", context)?.sourceUrl,
    porsche.sourceUrl, "A relevant same-tier page must replace the wrong fallback");
  assert.equal(choose([porsche, bosch], bosch.sourceUrl, "https://tcs.com", context)?.sourceUrl,
    porsche.sourceUrl, "Selection must not depend on source order");
}
const networkRail = {
  sourceUrl: "https://tcs.com/news/network-rail-global-network-operations",
  sourceTitle: "TCS transforms Network Rail global network operations",
  sourceType: "company_press_release",
};
const abb = {
  sourceUrl: "https://tcs.com/news/tcs-abb-network-operations",
  sourceTitle: "TCS and ABB sign multi-year global network operations deal",
  sourceType: "company_press_release",
};
assert.equal(preferredPublicArticleSource([networkRail, abb], networkRail.sourceUrl, "https://tcs.com",
  { referenceTitle: "TCS | ABB | Global network operations", providerName: "TCS", counterpartyNames: ["ABB"] })?.sourceUrl,
abb.sourceUrl, "ABB must match as a complete short entity token, not generic scope");
assert.equal(preferredPublicArticleSource([networkRail], networkRail.sourceUrl, "https://tcs.com",
  { referenceTitle: "TCS | ABB | Global network operations", providerName: "TCS", counterpartyNames: ["ABB"] }), null);
const mhp = { sourceUrl: "https://mhp.com/news/mhp-tcs",
  sourceTitle: "MHP and TCS announce acquisition agreement", sourceType: "company_press_release" };
assert.equal(preferredPublicArticleSource([mhp], mhp.sourceUrl, "https://tcs.com",
  { referenceTitle: "TCS | Acquisition | MHP", providerName: "TCS",
    counterpartyNames: ["MHP Management- und IT-Beratung GmbH"] })?.sourceUrl, mhp.sourceUrl);
console.log("Source identity regression checks passed.");
const rss = {sourceUrl:"https://news.google.com/rss/articles/abc", sourceTitle:"TCS and Porsche unveil new deal", publisherUrl:bosch.sourceUrl};
assert.equal(preferredPublicArticleSource([rss],rss.sourceUrl,"https://tcs.com",context)?.sourceUrl,rss.sourceUrl);
assert.equal(preferredPublicArticleSource([{...rss,publisherUrl:porsche.sourceUrl}],rss.sourceUrl,"https://tcs.com",context)?.sourceUrl,porsche.sourceUrl);
import { mentionsParty } from "../src/lib/source-authority";
assert.equal(mentionsParty("United Kingdom confirms an unrelated award","UNITED STATES ARMY"), false);
assert.equal(mentionsParty("The contract is awarded to another bank","BANK of Ireland"), false);
assert.equal(mentionsParty("MHP changes ownership","MHP Management- und IT-Beratung GmbH"), true);
