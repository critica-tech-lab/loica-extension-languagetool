# LanguageTool server — deploy (with n-gram model)

Runs the LanguageTool server **local to loica** (same host), with the optional
**n-gram language model** for context/confused-word detection.

## Why local, not remote

LT is light and its checks are inline + always-on, so it must not pay network
latency. Co-locate it with loica and point the extension at loopback:

```
LANGUAGETOOL_URL=http://localhost:8081
```

(The heavy, on-demand LLM layer is the one that runs remotely — LT does not.)

## 1. (Optional) n-gram data — English only, in practice

The n-gram model powers `CONFUSION_RULE`, which scores confused-word pairs from
a per-language `confusion_sets.txt`. **English** has a large set (their/there,
its/it's, then/than, …) so the n-gram helps. **Spanish's free set is
near-empty**, so the n-gram adds ~nothing there — verified: identical output
with vs without the ES data. Don't bother downloading it for Spanish; the LLM
layer is the real lever for ES.

Per-language dumps (zipped): `ngrams-en-20150817.zip` ~8.3 GB,
`ngrams-es-20150915.zip` ~1.6 GB (skip ES).

Only if you want English context checks:

```bash
cd deploy && mkdir -p ngrams && cd ngrams
curl -LO https://languagetool.org/download/ngram-data/ngrams-en-20150817.zip
unzip -q ngrams-en-20150817.zip && rm ngrams-en-20150817.zip   # -> ngrams/en/
```

Without n-gram data the server still runs fine on base rules — just remove the
`langtool_languageModel` env and the `./ngrams` volume from the compose file.

## 2. Run

```bash
docker compose up -d
# verify:
curl -s -XPOST http://localhost:8081/v2/check \
  --data-urlencode 'text=Nos vemos aya en la casa' --data 'language=es' | jq '.matches[].message'
```

Without the n-gram model the server still runs (base rules only); with it, the
`CONFUSION_RULE`-type matches appear for statistically-unlikely word sequences.

## 3. Point loica at it

Set `LANGUAGETOOL_URL=http://localhost:8081` in loica's environment, enable the
`languagetool` extension, rebuild/restart.
