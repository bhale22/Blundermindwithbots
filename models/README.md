# models/

- `maia3_simplified.onnx` — the **Maia 3** network from CSSLab, University of
  Toronto (https://github.com/CSSLab/maia3, AGPL-3.0), exported to ONNX with
  PyTorch 2.11 and run through onnx-simplifier for in-browser inference via
  ONNX Runtime Web. ~44 MB; downloaded on demand and cached client-side
  (see `maia-worker.js`). The move-index vocabulary lives in
  `data/all_moves_maia3.json` / `data/all_moves_maia3_reversed.json`.

The conversion is distributed under AGPL-3.0, same as upstream. Credit and
citations: `/credits` and `THIRD_PARTY_NOTICES.md`.
