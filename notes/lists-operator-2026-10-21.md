# 派单人 list operator change — 2026-10-21

Applied at the user's request (forwarded team requests, interpretation confirmed with the
user) to production at about 11:27 UTC as one guarded SQL transaction, first rehearsed on a
restored copy (a second run refuses). Files: `dmit-us:/root/sharecode-releases/20261021-lists-operator/`
(`apply.sql`, `applied.log`, `undo.sql` — not run). Four `AuditEvent` rows record it
(`ipSource` operator-ssh, `requestId` maintenance-20261021-lists).

- 派单人 hjq (account HJQ) is shown as 黄不了.
- The placeholder 秋莲 was linked to the Aurora account as the app's 关联账号 does (its 3
  sessions as 管理 moved to Aurora, the placeholder was removed) and is shown as Aurora.
- Lvguanglong123 became 管理 (agent) so he books sessions, and joined the end of the 派单人
  list as LVguanglong. He owned no private rooms, so no access needed revoking.
- 666 needed nothing: the techs' list already shows 666 on the 666 account, which stays a tech.

A pinyin input method had likely defeated the first attempt in the UI: Enter that confirmed
the composition saved the raw letters (fixed in the release after this change).
