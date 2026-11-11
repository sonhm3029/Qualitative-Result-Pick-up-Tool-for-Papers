# SR Qualitative Picker

Local web tool to choose qualitative results (ours = `GRN-SR`) for a paper figure.

    python tool/server.py                      # then open http://localhost:8765
    python tool/server.py --host 0.0.0.0 --port 9000      # remote machine: ssh -L 8765:localhost:8765 <host>
    python tool/server.py --ours GRN-SR --root /path/to/CVPR_qualitative_results

Needs only Python 3 + OpenCV (or Pillow) for thumbnails. No npm / no internet.
Expected data: `<root>/<Dataset>/{LR,HR,<Method>...}/<img>.png` and `<root>/metrics/<Dataset>_wide.csv`.

## Workflow
1. **Browse & Filter** – table of GRN-SR metrics per image with rank (#1..) and margin over the best selected baseline.
   Choose baselines to compare against, score metrics, "require rank ≤ K on …", min #wins, then sort by
   composite advantage / wins / any metric margin|value|rank. ☆ bookmarks, ✕ rejects (hidden).
2. **Compare (loupe)** – drag the ROI on the overview; every method shows the same region (synced
   pan/zoom/crosshair). Local PSNR vs HR per tile, error map (F), auto-suggest regions where GRN-SR
   beats baselines locally. Up to 3 ROIs per image. P = add to figure.
3. **Figure** – rows = picked images, columns = methods (reorder / hide / rename). Two layouts:
   - **A · Strip**: one row, every method = full image + red box + zoomed inset (multiple ROIs OK).
   - **B · Split**: big LR/HR panels with thin ROI box + thick inset, then a grid of per-method crops with the label
     under each crop (uses ROI 1; "crop-grid columns" 0 = auto 2 rows).
   Export: **Figure PNG** (1–3×) or **Pieces (.zip)** for drawio/PowerPoint: per row `full/`, `full_boxed/`, `crops/roiK_<Method>.png`,
   plus `figure_<layout>.png` and `layout.json` (ROI coords). "Save … → tool/exports/" writes (and unzips) on the server.
4. **Summary** – dataset means and per-baseline win-rates (sanity check vs. your paper table).

Keys (Compare): ←/→ image · WASD move ROI (shift = faster) · Q/E shrink/grow · P pick · X reject · F error map · 1/2/3 ROI.

State (picks, ROIs, filters, figure style) autosaves to `tool/selections.json`.
