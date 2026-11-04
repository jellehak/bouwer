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

Om een ander model of endpoint te gebruiken:

```sh
OLLAMA_MODEL=llama3.1 LLM_SERVER=http://localhost:11434 npm start
```

Het standaard endpoint staat in `.env` als `LLM_SERVER`. Een waarde die al in de shell is ingesteld, heeft voorrang.

`OLLAMA_NUM_CTX` bepaalt de contextgrootte en staat standaard op `4096`. Bouwer vat oudere conversatie samen wanneer de bewaarde chatgeschiedenis deze limiet nadert. Tijdens het werken toont Bouwer voortgang per architect-, worker-, samenvattings- en commandostap. `:clear` wist zowel de geschiedenis als de samenvatting; `:help` toont alle opdrachten.
