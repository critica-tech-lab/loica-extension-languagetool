# Custom LanguageTool image: bakes our own accepted-word lists into the base
# Hunspell dictionaries so they survive container restarts.
#
# Words are APPENDED to the built-in spelling.txt (never overwrite it — a volume
# mount would clobber LT's base dictionary). Because they're baked into the
# image at build time, `docker compose restart` keeps them; only a change to the
# word lists needs a `docker compose build`.
#
# spelling.txt = words the checker accepts AND uses to generate suggestions.
# One word per line, no spaces. Lines starting with `#` are ignored by LT.
FROM erikvl87/languagetool
USER root
COPY dict/en_spelling_additions.txt /tmp/en.txt
COPY dict/es_spelling_additions.txt /tmp/es.txt
# Leading blank line (echo) guards against the base file lacking a trailing \n.
RUN (echo; cat /tmp/en.txt) >> org/languagetool/resource/en/hunspell/spelling.txt \
 && (echo; cat /tmp/es.txt) >> org/languagetool/resource/es/hunspell/spelling.txt \
 && rm /tmp/en.txt /tmp/es.txt
USER languagetool
