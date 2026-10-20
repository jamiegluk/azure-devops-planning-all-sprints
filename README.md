# Azure DevOps Planning All Sprints

A Greasemonkey / Tampermonkey userscript that adds a **"Show more"** button to
the **Sprints › Planning** pane in Azure DevOps, listing every remaining team
sprint beyond the built-in limit.

Out of the box, the Planning pane only shows a handful of upcoming sprints. With
this script installed, a button appears beneath them:

```
Show more (5 sprints)
```

Expanding it shows a card for each additional sprint, styled to match the
native ones, with dates, planned effort, working days, and work item counts.

## Installation

1. Install a userscript manager in your browser:
   - [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari)
   - [Greasemonkey](https://www.greasespot.net/) (Firefox)
   - [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Firefox, Edge)
2. Click
   [**Install azure-devops-planning-all-sprints.user.js**](https://raw.githubusercontent.com/jamiegluk/azure-devops-planning-all-sprints/master/azure-devops-planning-all-sprints.user.js)
   — your userscript manager will prompt you to install it.
3. Navigate to a sprint in Azure DevOps and open the **Planning** pane.

## How It Works

The script uses a `MutationObserver` to watch for the Planning pane appearing in
the DOM. When detected, it:

1. Loads the team's iterations and settings, and the project's process
   configuration, from the Azure DevOps REST API.
2. Works out which team sprints come after the last one the native pane shows.
3. Adds a **"Show more"** button listing how many extra sprints there are.
4. On expand, queries the work items in those sprints and renders a card for
   each, showing:
   - Start and end dates, in the same format as the native cards.
   - **Planned Effort** — summed from requirement-level work items.
   - **Working days** — based on the team's working days and days off.
   - **Work item counts** by type, including parents of tasks in the sprint
     (matching the native pane's behaviour).
5. Re-syncs when the native cards change (e.g. switching sprint or dragging
   items onto a sprint).

## Compatibility

- Azure DevOps Services (`dev.azure.com` and `*.visualstudio.com`)
- Tested with Tampermonkey and Greasemonkey
- Works from: the Sprints › Planning pane

## License

[MIT](LICENSE) — Jamie Lievesley
