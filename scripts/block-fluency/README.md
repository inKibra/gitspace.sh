# Block fluency eval

This eval measures whether real agents draw GitSpace blocks (`gitspace-ui`, `mermaid` and `svg` fences) unprompted on a live account, whether the blocks they choose fit the situation, and whether those blocks are valid. Rerun it after the drawing brief or the `gitspace-ui` skill changes, and compare the results.

## Prompts

`prompts.json` holds two kinds of prompt:

- `scenario`: a plain developer request where a block helps. Its `expected` field lists the components that fit.
- `control`: a request where no block is the right answer, such as a one-line factual question or a quick yes/no. A block here counts as over-drawing.

The prompt text never hints at a visual form. The `expected` sets stay in the JSON and never appear in the text. `run.ts` refuses a prompt whose prose uses a word that suggests a form: chart, graph, diagram, visual, draw, walkthrough, timeline, breakdown, side by side, "a table", and similar words. It ignores code fences and inline code, "on the table", and a named SQL table such as "the users table".

`bun scripts/block-fluency/run.ts --check` runs only this check, with no account and no environment variables.

## Run

```sh
GITSPACE_ACCOUNT_URL=https://<account>.gitspace.sh \
GITSPACE_MCP_TOKEN="$(cat ~/.config/gitspace-mcp/<account>.token)" \
bun scripts/block-fluency/run.ts --project <eval project id> [outDir]
```

| Option | Default | Meaning |
|---|---|---|
| `--project` | required | The project the run's workspaces are created in. Use a project kept only for this eval, with the inference profile under test assigned. |
| `--models` | `anthropic/claude-opus-5-5,openai/gpt-6-astra` | `provider/model` pairs. Each one is picked through session controls (`setModel`), the same way the composer's model picker does it. |
| `--thinking` | `medium` | Set with `setThinking` after the model, so every model runs at the same thinking level. |
| `--prompts` | all | Comma-separated ids from `prompts.json`. |
| `--concurrency` | `2` | Runs at a time. Keep it low to stay under provider rate limits. |
| `--timeout-minutes` | `15` | How long one turn may take. |
| `--repeat` | `1` | Runs per (prompt, model) pair. Every pair runs once before any pair runs a second time. |
| `outDir` | `~/work/block-fluency-results/<timestamp>/` | Keep it outside the repo. |

`bun scripts/block-fluency/run.ts --rescore <outDir>` scores a finished run's `results.json` again against the current `prompts.json`, using its `expected` sets and `requiresAsk`. It needs no account. It writes `results.rescored.json` and `results.rescored.md` next to `results.json`. Use it after changing an expectation.

Each run of a (prompt, model) pair goes through these steps:

1. Create a workspace from the project's base branch.
2. Pick the model.
3. Submit the prompt.
4. Wait until the conversation stops running.
5. Read the turn's assistant replies from the transcript.
6. Score the replies.
7. Archive the workspace.

The prompts contain all of their data, so they need no repository content and no machine.

## Output

- `results.json`: every run with its score, tool calls, usage and errors, plus totals per model.
- `results.md`: a table per prompt and model, totals per model, and every block that was invalid as first written, with its validator issues.
- `runs/<prompt>__<model>.md`: the reply text exactly as the transcript shows it. If the agent wrote several messages, they are joined with `<!-- next message -->`. With `--repeat` above 1, each file name ends in `__<attempt>`.
- `runs/<prompt>__<model>.original.md`: written only when a fix step corrected a block. It holds the reply as first written.
- `runs/<prompt>__<model>.json`: the same record as in `results.json`.

## Scoring

The scorer uses the repo's block validator (`packages/protocol/src/gitspace-ui.ts`: `extractBlocks`, `fenceSpec`, `validateMarkdownBlocks`). It validates each assistant message as one document, the same way the runtime checks it. It records:

- **Blocks and components:**
  - a `gitspace-ui` block counts every element type in its spec;
  - `mermaid` counts as `Mermaid`;
  - `svg` counts as `Svg`.
- **Drew:** the reply has at least one block.
- **Fit:** at least one component from the scenario's `expected` set appears. Fit and the ask measures below are judged when the report is written, against the current `prompts.json`.
- **Invalid as written, and fixed:** the transcript and the snapshot both show a reply with its corrections already applied. The original stays visible in the snapshot only between the reply and the correction. While the turn runs, the harness reads the snapshot every 2 s and keeps every version of each assistant text part. A row that the transcript marks `corrected` was fixed by the hidden fix step (`fix_block`). For such a row, the version before the corrected one is the original, and the scorer validates that original.
  - If the run never saw the original, the scorer uses the issues that the `corrected` record lists for the block. In that case the block's `written` is null.
  - A block that is still invalid in the stored text counts as invalid as written and not fixed.
- **Short or full form:** short form names a component after `gitspace-ui` in the fence; full form is a whole `{ root, elements }` spec.
- **Required ask:** an element with `ask: { required: true }`, written as `ask=required` in the short form. A scenario with `requiresAsk` (the person said they will decide) wants one. A required ask on a scenario without `requiresAsk` is an **over-ask**: the person asked for the agent's pick, so the agent should recommend and continue. The run also records whether the agent used the `ask` tool instead (`askTool`), and how many questions were left open.
- **Prose before the first block:** characters of reply text before the first fence.
- **Reply characters, turn duration and usage:** usage is the session's request and token totals, plus `costUsd`. `costUsd` is 0 for subscription sign-ins.

Totals per model:

- **drew unprompted** = scenario replies with a block ÷ scenario replies;
- **fit** = scenario replies with an expected component ÷ scenario replies;
- **over-drew** = control replies with a block ÷ control replies;
- **required ask when wanted** = `requiresAsk` scenario replies with a required ask ÷ `requiresAsk` scenario replies;
- **over-ask** = other scenario replies with a required ask ÷ other scenario replies;
- **blocks per scenario reply**;
- **invalid-before-fix rate** = invalid as written ÷ blocks;
- **fixed rate** = fixed ÷ invalid as written.

The scorer runs the validator in your checkout. If your checkout's validator differs from the deployed one, the scores can differ from what the runtime saw.
