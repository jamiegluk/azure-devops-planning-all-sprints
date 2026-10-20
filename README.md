# Azure DevOps Planning All Sprints

A Tampermonkey / Violentmonkey userscript that adds a **"Show more"** button to
the **Sprints › Planning** pane in Azure DevOps, listing every remaining team
sprint beyond the built-in limit.

Out of the box, the Planning pane only shows a handful of upcoming sprints. With
this script installed, a button appears beneath them:

```
Show more (5 sprints)
```

Expanding it shows a card for each additional sprint, styled to match the
native ones, with dates, planned effort, working days, and work item counts.
Each card also has a small **refresh** button to reload just that sprint's
numbers.

## Installation

1. Install a userscript manager in your browser:
   - [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari)
   - [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Firefox, Edge)
2. Click
   [**Install azure-devops-planning-all-sprints.user.js**](https://raw.githubusercontent.com/jamiegluk/azure-devops-planning-all-sprints/master/azure-devops-planning-all-sprints.user.js)
   — your userscript manager will prompt you to install it.
3. Navigate to a sprint in Azure DevOps and open the **Planning** pane.

The script gets the team from the page you're on, so it works for any team.

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
   - A **refresh** button that re-fetches that sprint's numbers on its own.
     It spins while loading and turns red if the refresh fails; hover over it to
     see the error, and click to retry.
5. Re-syncs when the native cards change (e.g. switching sprint or dragging
   items onto a sprint).

## Limitations

- **No drag and drop**: you can't drag backlog items onto the extra cards. That
  only works on the built-in cards.
- **Refreshing**: the numbers are fetched again each time you open the list and
  whenever the built-in cards change. If you change a work item's iteration
  straight to one of the extra sprints from the grid, the cards won't update
  until you click that card's refresh button, or close and reopen the list.
- **Links reload the page**: clicking a sprint link on the extra cards loads the
  whole page, unlike the built-in links.

## Compatibility

- Azure DevOps Services (`dev.azure.com` and `*.visualstudio.com`)
- Works with Tampermonkey and Violentmonkey
- Works from: the Sprints › Planning pane

## License

[MIT](LICENSE) — Jamie Lievesley
