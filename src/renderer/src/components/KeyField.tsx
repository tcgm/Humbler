// The keyfield: old humblebundle.com's big grey box ("Reveal your Steam key")
// that becomes the key itself once revealed, plus redeem/copy and the line
// underneath (redeemed-on-platform, deadline, instructions).
import type { KeyEntry } from "@shared/types";
import { api, useStore } from "../store";
import { formatDate, isExpiring, platformOf } from "../util";
import { ArmButton, CopyButton } from "./ui";

export function KeyField({ k }: { k: KeyEntry }) {
  const { busy, beginRedeem, setRedeemed } = useStore();
  const p = platformOf(k);

  let field;
  switch (k.status) {
    case "revealed":
      field = (
        <>
          <div className="keyfield redeemed" title="Click the key to select it">
            <span className="keyfield-value">{k.key}</span>
          </div>
          {p.redeem && k.key && (
            <button
              className={`hb-btn small${k.platformRedeemed ? " ghost" : ""}`}
              title={`Redeem on ${p.name}: opens in your browser${p.id === "steam" ? " with the key filled in" : ""}`}
              onClick={() => beginRedeem(k, p.name, p.redeem!(k.key!))}
            >
              {k.platformRedeemed ? "Redeem again" : "Redeem"}
            </button>
          )}
          {k.key && <CopyButton text={k.key} />}
        </>
      );
      break;
    case "gifted":
    case "link":
      field = (
        <>
          <div className="keyfield gifted">{k.status === "gifted" ? "Gifted" : "Redeem link"}</div>
          {k.key && <CopyButton text={k.key} label="Copy link" />}
        </>
      );
      break;
    case "expired":
      field = <div className="keyfield expired">This key has expired</div>;
      break;
    case "sold-out":
      field = <div className="keyfield expired">Sold out</div>;
      break;
    default: {
      const label = `Reveal your ${p.name ? `${p.name} ` : ""}key`;
      field = k.v2 ? (
        // New-site keys: reveal on Humble's own page until Humbler knows the new reveal action.
        <button className="keyfield" title="Opens this item on Humble (right) so you can reveal it there" onClick={() => k.contentUrl && api.openUrl(k.contentUrl)}>
          {label}
        </button>
      ) : (
        <ArmButton className="keyfield" disabled={busy} armedText="Click again to reveal. It can't be gifted afterwards" onFire={() => api.revealKeys([k.id]).then(() => undefined)}>
          {label}
        </ArmButton>
      );
    }
  }

  const meta = [];
  if (k.status === "revealed") {
    meta.push(
      k.platformRedeemed ? (
        <span key="r" className="redeemed-ok">
          ✓ Redeemed{k.platformRedeemed.platform ? ` on ${k.platformRedeemed.platform}` : ""} · {formatDate(k.platformRedeemed.at)}{" "}
          <a title="Mark as not redeemed" onClick={() => setRedeemed(k.id, false)}>
            undo
          </a>
        </span>
      ) : (
        <span key="r">
          <a title="Record that you've activated this key yourself" onClick={() => setRedeemed(k.id, true, p.name || null)}>
            Mark as redeemed
          </a>
        </span>
      ),
    );
  }
  if (k.status === "unused" && k.expiry) {
    meta.push(
      <span key="e" className={isExpiring(k) ? "soon" : ""}>
        Must be redeemed by {formatDate(k.expiry)}
        {k.daysLeft != null ? ` (${k.daysLeft} day${k.daysLeft === 1 ? "" : "s"} left)` : ""}
      </span>,
    );
  }
  if (k.instructions) {
    meta.push(
      <details key="i">
        <summary>Redemption instructions</summary>
        <p>{k.instructions}</p>
      </details>,
    );
  }

  return (
    <div>
      <div className="keyrow">{field}</div>
      {meta.length > 0 && <div className="keymeta">{meta}</div>}
    </div>
  );
}
