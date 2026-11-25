import assert from "node:assert/strict";
import {
  preferredArticleSource,
  preferredPublicArticleSource,
  isProviderWebsiteUrl,
  sourceAuthorityTier,
} from "../src/lib/source-authority";

const google = {
  sourceUrl: "https://news.google.com/rss/articles/example",
  sourceName: "Google News",
  sourceType: "news_article",
};
const provider = {
  sourceUrl: "https://provider.example/investors/contract-award",
  sourceName: "Provider IR",
  sourceType: "investor_relations_release",
};
const buyer = {
  sourceUrl: "https://procurement.example/award/123",
  sourceName: "Official procurement portal",
  sourceType: "procurement_notice",
};

assert.ok(sourceAuthorityTier(provider) > sourceAuthorityTier(google));
assert.ok(sourceAuthorityTier(buyer) > sourceAuthorityTier(provider));
assert.equal(preferredPublicArticleSource([google, provider])?.sourceUrl, provider.sourceUrl);
assert.equal(preferredPublicArticleSource([google, provider, buyer])?.sourceUrl, buyer.sourceUrl);
assert.equal(preferredArticleSource([google, provider])?.sourceUrl, provider.sourceUrl);
assert.equal(
  preferredPublicArticleSource([google], "https://provider.example/news/direct-announcement")?.sourceUrl,
  "https://provider.example/news/direct-announcement",
);
assert.equal(preferredPublicArticleSource([google], "contrackgenius://internal/123")?.sourceUrl, google.sourceUrl);
const mislabeledProviderPage = {
  sourceUrl: "https://news.provider.example/newsroom/contract-award",
  sourceName: "Legacy import",
  sourceType: "news_article",
};
assert.equal(
  preferredPublicArticleSource(
    [google, mislabeledProviderPage],
    null,
    "https://www.provider.example",
  )?.sourceUrl,
  mislabeledProviderPage.sourceUrl,
);
assert.ok(sourceAuthorityTier(mislabeledProviderPage, "https://provider.example") > sourceAuthorityTier(google));
assert.equal(isProviderWebsiteUrl("https://ir.provider.example/results", "https://provider.example"), true);
assert.equal(isProviderWebsiteUrl("https://provider.example.evil.test/results", "https://provider.example"), false);

const unrelatedProviderPage = {
  sourceUrl: "https://provider.example/newsroom/women-in-technology-award",
  sourceName: "Provider Newsroom",
  sourceType: "vendor_press_release",
  sourceTitle: "Provider recognised in women in technology awards",
};
assert.equal(
  preferredPublicArticleSource(
    [google, unrelatedProviderPage],
    google.sourceUrl,
    "https://provider.example",
    { referenceTitle: "Provider | Acquisition | Robotiq.ai | Agentic automation", providerName: "Provider" },
  )?.sourceUrl,
  google.sourceUrl,
);
assert.equal(
  preferredPublicArticleSource(
    [google, { ...provider, sourceTitle: "Provider acquires Robotiq.ai for agentic automation" }],
    google.sourceUrl,
    "https://provider.example",
    { referenceTitle: "Provider | Acquisition | Robotiq.ai | Agentic automation", providerName: "Provider" },
  )?.sourceUrl,
  provider.sourceUrl,
);

const currentProviderLink = {
  ...provider,
  sourceUrl: "https://provider.example/news/current-contract-award",
  sourceTitle: "Provider wins current contract award",
};
assert.equal(
  preferredPublicArticleSource(
    [currentProviderLink, provider],
    currentProviderLink.sourceUrl,
    "https://provider.example",
    { referenceTitle: "Provider wins current contract award", providerName: "Provider" },
  )?.sourceUrl,
  currentProviderLink.sourceUrl,
);

assert.equal(
  preferredPublicArticleSource(
    [google, { ...provider, sourceTitle: "Provider announces contract with Unrelated Industries" }],
    google.sourceUrl,
    "https://provider.example",
    { referenceTitle: "Provider announces contract with Acme Logistics", providerName: "Provider" },
  )?.sourceUrl,
  google.sourceUrl,
);
assert.equal(
  preferredPublicArticleSource(
    [{ ...google, sourceTitle: "Provider announces Acme Logistics deal", publisherUrl: provider.sourceUrl }],
    google.sourceUrl,
    "https://provider.example",
    { referenceTitle: "Provider announces contract with Acme Logistics", providerName: "Provider" },
  )?.sourceUrl,
  provider.sourceUrl,
);
assert.equal(
  preferredPublicArticleSource([], "contrackgenius://private/123"),
  null,
);

console.log("Passed 17 source-authority checks.");
