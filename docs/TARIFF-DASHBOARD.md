# Native NT / VT dashboard view

`dashboards/dubnice-vt-nt.yaml` is a single Lovelace view, added to the existing
Dubnice dashboard at `/dashboard-dubnice/elektrina-nt-vt` using the raw configuration
editor. Existing Home, Bedroom and Office views are retained. To reuse it, append
this view object to the dashboard's `views` list; do not replace the whole dashboard.
Remove that view to undo the presentation change.

Uses native Energy date selection, statistic and stacked statistics graph cards.
All cards read existing external Recorder statistic IDs with `change`, not the
cumulative sensor state. NT is blue, VT orange and fixed costs grey. Tariff graphs
use daily periods because the tariff split is available as daily readings. Manual
history remains explicitly described as an estimate. The cards do not write data
or change Energy preferences: there is still one physical grid source, retaining
the actual measured total consumption profile.

Verified live on HA Core 2026.11.0 on 2026-11-09:

- Nov 8: NT 46.186 kWh + VT 5.160 kWh; measured total 51.34575 kWh
  (rounding of daily registers explains the 0.00025 kWh difference).
- Nov 8 costs: NT 158.10114404 + VT 21.6484704 + fixed 28.066666667 CZK;
  displayed total 207.82 CZK.
- November to Nov 8: NT 199.280 kWh, VT 18.869 kWh, total 218.1465 kWh;
  displayed costs 682.16 + 79.16 + 224.53 = 985.86 CZK (rounded).
- Shared date selector updates both graphs and all summaries; units are explicit
  for external statistics. No extra integration or custom frontend card required.
- Costs before 2025-09-18 are excluded because price inputs are missing; this
  limitation is visible on the dashboard.
