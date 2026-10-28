# Earth System World Model — project website

A project page for the paper **"Earth System World Model for What-If Simulations: A Case
Study for Terrestrial Ecosystems"** (ACM SIGSPATIAL '26).

The page is not a set of screenshots. The paper's world model — all 519,047 parameters of it —
is exported to the browser and runs there. You fly a globe, pick a forest cell, change its
canopy structure in any year you like, and the model predicts the coupled response of the
ecosystem: canopy height, aboveground biomass, soil carbon, LAI, GPP, NPP and heterotrophic
respiration, year by year, against the untouched baseline. Nothing is sent to a server; the
forecast is computed on your machine from the cell's own climate forcing.

The forest is drawn in 3D from those numbers. Choose an action and the plot forks into two
futures side by side, the same trees left alone and living through your harvest, fire or
replanting. The difference is drawn on the trees: canopy a scenario removed stands as glass
ghosts of the trees it would have been, extra growth lights up the crowns above the no-action
height, and both canopy levels ring each plot with the gap measured. A short section after it
makes the case for interactivity: the same what-if question put to a passive emulator, which has
no input for it, and to the world model, which answers in milliseconds.

Below it is a digital twin of a landscape: 256 contiguous cells of the western Amazon, where
Brazil, Colombia and Peru meet, inside the paper's NW South America study region, each run by the
same model in parallel Web Workers. The board is the real place: each tile carries its own patch
of the NASA Blue Marble image, the region around it lies underneath, and its rivers and towns are
named. Paint logging, fire, replanting or protection onto the board, cell by cell and year by
year; the edited cells re-run and the landscape plays forward, with its carbon totals.
`tests.html` checks both against the paper's PyTorch code in your own browser.

A one-minute film (`assets/film/`) plays right after the hero: an emulator lets you watch, this
world model lets you interact (two disturbances, a carbon goal, a real-world landscape), and how it
works, in the paper's three contributions. It was rendered frame by frame from this page's own
model, forest and landscape, with a score generated in code.

## Paper

Zhihao Wang, Ruichen Wang, Ruohan Li, Lei Ma, George Hurtt, Xiaowei Jia, Gengchen Mai,
Shaowen Wang, Yiqun Xie. *Earth System World Model for What-If Simulations: A Case Study for
Terrestrial Ecosystems.* ACM SIGSPATIAL '26. [arXiv:2609.08855](https://arxiv.org/abs/2609.08855)

## Data

The ecosystem states and climate forcing behind the page come from the **CarbonGlobe** dataset:
<https://github.com/zhwang0/carbon-globe>. The site ships only the cells it needs, quantized to
int16 (the landscape's are packed further, 2.8 MB to 1.4 MB, and unpacked exactly in the
browser). The full dataset lives at that link.

## Previewing locally

The site is static; it needs no build step, only a server (ES modules will not load over
`file://`).

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Before publishing, the same check the deploy workflow runs:

```sh
python3 scripts/validate_site.py .
```

It confirms every local link resolves and that the model weights and cell chunks are exactly
the size their manifests claim. Pass `--partial` to run it against a page still being written.

## Credits

- Earth imagery: NASA **Blue Marble** (day) and **Black Marble** (night lights) — public domain.
- Rivers, towns and borders: **Natural Earth** — public domain.
- 3D rendering: [three.js](https://threejs.org), MIT licence (vendored, no CDN).
- Underlying ecosystem simulations: the **Ecosystem Demography (ED)** model, University of Maryland.
- Figures reproduced from the paper.
