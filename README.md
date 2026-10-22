# Earth System World Model — project website

A project page for the paper **"Earth System World Model for What-If Simulations: A Case
Study for Terrestrial Ecosystems"** (ACM SIGSPATIAL '26).

The page is not a set of screenshots. The paper's world model — all 519,047 parameters of it —
is exported to the browser and runs there. You fly a globe, pick a forest cell, change its
canopy structure in any year you like, and the model predicts the coupled response of the
ecosystem: canopy height, aboveground biomass, soil carbon, LAI, GPP, NPP and heterotrophic
respiration, year by year, against the untouched baseline. Nothing is sent to a server; the
forecast is computed on your machine from the cell's own climate forcing.

## Paper

Zhihao Wang, Ruichen Wang, Ruohan Li, Lei Ma, George Hurtt, Xiaowei Jia, Gengchen Mai,
Shaowen Wang, Yiqun Xie. *Earth System World Model for What-If Simulations: A Case Study for
Terrestrial Ecosystems.* ACM SIGSPATIAL '26. [arXiv:2609.08855](https://arxiv.org/abs/2609.08855)

## Data

The ecosystem states and climate forcing behind the page come from the **CarbonGlobe** dataset:
<https://github.com/zhwang0/carbon-globe>. The site ships only the handful of cells it needs,
quantized to int16 — the full dataset lives at that link.

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
- 3D rendering: [three.js](https://threejs.org), MIT licence (vendored, no CDN).
- Underlying ecosystem simulations: the **Ecosystem Demography (ED)** model, University of Maryland.
- Figures reproduced from the paper.
