# Bouwer

Een minimale coding-agent voor de Ollama `/api/chat`-endpoint. Bouwer gebruikt een architect voor een beknopt plan en een worker om dat plan uit te voeren. Alleen de worker krijgt tools voor Node.js-code en terminalcommando's; voor elk commando is goedkeuring nodig.

## Vereisten

- Node.js 20 of hoger
- Een draaiende Ollama-server en een model dat tool-calling ondersteunt

```sh
ollama pull qwen2.5-coder:7b
npm start
```

Start een nieuwe werkomgeving in `workspace/` met een automatisch gegenereerde mapnaam:

```sh
npm start -- --workspace
```

Of geef zelf een mapnaam op:

```sh
npm start -- --workspace snake
```

Bouwer maakt de map aan en voert alle goedgekeurde terminal- en Node.js-commando's daarin uit. Zonder `--workspace` blijft Bouwer in de huidige map werken.

Bestaat de workspace al, dan kies je tussen **doorgaan** (standaard), **opnieuw beginnen** of **annuleren**. Opnieuw beginnen verplaatst de bestaande map naar een unieke `<naam>.backup-...` naast de workspace en maakt een lege map aan; er wordt niets verwijderd.

## Werken met een plan

Voer een bestaand Markdown-plan direct uit:

```sh
npm start -- --plan plan.md
```

Of start met `--plan` zonder bestandsnaam en typ je opdracht. Als `plan.md` nog niet bestaat, schrijft de architect een beknopt plan met checkboxes voordat de worker begint:

```sh
npm start -- --workspace snake --plan
```

Een bestaand plan wordt niet opnieuw door de architect gegenereerd. De worker krijgt de opdracht om voltooide en geverifieerde stappen met `- [x]` af te vinken via de bestaande tools, met jouw goedkeuring. Geweigerde updates worden dus niet opgeslagen. Bewerk het document zelf om de richting bij te sturen; Bouwer leest het opnieuw bij iedere vervolgvraag.

Paden naar bestaande plannen zijn relatief aan de map waarin je Bouwer start. Met `--workspace` wordt het plan naar de nieuwe workspace gekopieerd; het bronbestand blijft ongewijzigd. Een ontbrekend expliciet opgegeven bestand, een leeg plan of een plan groter dan tweemaal `numCtx` in tekens geeft een foutmelding. Zonder `--plan` blijft Bouwer werken zonder een plandocument.

Bij doorgaan in een bestaande workspace met `--plan` krijgt het plan in de workspace voorrang op het bronplan, zodat afgevinkte stappen behouden blijven.

## Configuratie

Instellingen staan in `bouwer.config.json` (gedeeld) en `.bouwer.json` (persoonlijk; genegeerd door git). De persoonlijke config overschrijft de gedeelde config; omgevingsvariabelen overschrijven beide. Beschikbare velden:

```json
{
  "server": "https://abe-llm.silky.dev",
  "model": "cumulus",
  "numCtx": 4096,
  "workspaceDir": "workspace",
  "permissionMode": "ask"
}
```

`workspaceDir` bepaalt waar `--workspace` de nieuwe werkmappen aanmaakt. `permissionMode` is `ask` (standaard, vraagt goedkeuring voor elke toolaanroep) of `allow-all` (voert shell- en Node.js-toolaanroepen uit zonder bevestiging). Stel dit tijdelijk in met `--permission-mode`:

```sh
npm start -- --permission-mode allow-all
```

De CLI-optie overschrijft de config voor die run. Configuratie wordt geladen vanuit de huidige projectmap. Ontbrekende configbestanden zijn toegestaan; ongeldige JSON of onbekende instellingen geven een foutmelding.

Bij goedkeuring toont Bouwer het type actie, de werkmap, timeout en volledige opdracht of Node.js-code met regelnummers. De bevestigingsvraag staat onder de code: `y`/`ja` staat uitvoering toe; `n`/`nee` of Enter weigert. Statussen en toestemmingsvragen gebruiken emoji en kleuren in een interactieve terminal. Met `NO_COLOR=1` schakel je kleuren uit; bij omgeleide uitvoer worden geen kleurcodes toegevoegd.

Om een ander model of endpoint tijdelijk te gebruiken:

```sh
OLLAMA_MODEL=llama3.1 LLM_SERVER=http://localhost:11434 npm start
```

Omgevingsvariabelen uit `.env` blijven als fallback beschikbaar.

`OLLAMA_NUM_CTX` bepaalt de contextgrootte en staat standaard op `4096`. Bouwer vat oudere conversatie samen wanneer de bewaarde chatgeschiedenis deze limiet nadert. Tijdens het werken toont Bouwer voortgang per architect-, worker-, samenvattings- en commandostap. `:clear` wist zowel de geschiedenis als de samenvatting; `:help` toont alle opdrachten.
