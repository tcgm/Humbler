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
  const auto = k.status === "revealed" ? k.autoRedeemed : null;
  switch (k.status) {
    case "revealed":
      // Humble redeemed it to your account itself: nothing to activate. Any
      // value is Humble's redemption code, kept (and copyable) for the record.
      if (auto) {
        const where = auto.platform || p.name || "platform";
        field = (
          <>
            <div className="keyfield redeemed auto" title={`Humble redeemed this to your ${where} account${auto.account ? ` (${auto.account})` : ""}`}>
              ✓ Redeemed to your {where} account{auto.account ? ` (${auto.account})` : ""}
            </div>
            {k.key && <CopyButton text={k.key} label="Copy code" />}
          </>
        );
        break;
      }
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
      field = (
        <div className="keyfield soldout" title="Humble has run out of keys for this item">
          ⚠ Sold out
        </div>
      );
      break;
    default: {
      const label = `Reveal your ${p.name ? `${p.name} ` : ""}key`;
      field = k.v2 ? (
        // New-site keys: reveal on Humble's own page; Humbler watches and picks the key up as soon as you do.
        <button className="keyfield" title="Opens this item on Humble (right). Reveal it there and it shows up here right away." onClick={() => api.revealOnHumble(k.id)}>
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
  if (auto && (!k.platformRedeemed || k.platformRedeemed.auto)) {
    meta.push(
      <span key="r" className="redeemed-ok">
        ✓ Redeemed automatically by Humble{auto.at ? ` · ${formatDate(auto.at)}` : ""}
        {k.key && (
          <>
            {" · code "}
            <span className="auto-code" title="Humble's redemption code (not a key you need to enter)">
              {k.key}
            </span>
          </>
        )}
      </span>,
    );
  } else if (k.status === "revealed") {
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
  if (k.status === "sold-out") {
    meta.push(
      <span key="so" className="soldout-note">
        Humble ran out of keys for this before you revealed it. Humble support can sometimes offer a replacement:{" "}
        <a className="ext-out" title="https://support.humblebundle.com/" onClick={() => api.openExternal("https://support.humblebundle.com/")}>
          Humble support ↗
        </a>
      </span>,
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
  // the same link can appear twice in one set of instructions
  const links = (k.instructionLinks || []).filter((l, i, all) => all.findIndex((x) => x.href === l.href && x.text === l.text) === i);
  // Instructions that are only a link (e.g. "Epic Game Store Instructions")
  // show as that link; longer ones expand, with their links underneath.
  // Links always open in your browser, never in Humbler.
  const linkEls = links.map((l, i) => (
    <a key={`${i}|${l.href}`} className="ext-out" title={l.href} onClick={() => api.openExternal(l.href)}>
      {l.text} ↗
    </a>
  ));
  const onlyLinks = links.length > 0 && (k.instructions || "").replace(/\s+/g, " ").trim() === links.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
  if (onlyLinks) {
    meta.push(<span key="i">{linkEls}</span>);
  } else if (k.instructions) {
    meta.push(
      <details key="i">
        <summary>Redemption instructions</summary>
        <p>{k.instructions}</p>
        {linkEls.length > 0 && <p className="instr-links">{linkEls}</p>}
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
