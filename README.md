# token-turns

A Claude Code mod that shows how many tokens each prompt costs, alongside context-window fill and your 5-hour and weekly usage. It sits above the prompt as one line, or as two compact rows:

```
                        ▂▅▁▇▃▂█▄  Δ +6.6k  694k cached
              ctx ▰▰▱▱▱▱▱▱▱▱ 18%   5h 78% +0.4   wk 80% +0.1
```

- **Δ** is the last turn's tokens (input + cache writes + output), summed over every model request in the turn, subagents' included. It's orange while a turn is running.
- **cached** is the turn's cache reads, shown apart because each request re-reads the whole context from the cache.
- **ctx** fills green to red; the red cells at the end are what the last turn added.
- **5h** and **wk** are your plan's rate-limit windows, with the last turn's change in grey. Claude Code only reports these as percentages.
- The sparkline is the Δ of recent turns.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install token-turns --marketplace schctl/claude-token-turns
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install token-turns --marketplace schctl/claude-token-turns
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `schctl/claude-token-turns`, then Add plugin.

The repository is private, so you need access to it and GitHub set up on your computer.

## Use

| Command | What it does |
| --- | --- |
| `/tokens` | Show or hide the display |
| `/tokens compact` | One line above the prompt |
| `/tokens expanded` | Two rows with the sparkline |

## Develop

```
claude --plugin-dir .           # run it from this folder
claude plugin test .            # run the tests
claude plugin validate .
```

## License

MIT
