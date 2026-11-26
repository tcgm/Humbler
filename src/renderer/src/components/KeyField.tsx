// The keyfield: old humblebundle.com's big grey box ("Reveal your Steam key")
// that becomes the key itself once revealed, plus redeem/copy and the line
// underneath (redeemed-on-platform, deadline, instructions).
import type { KeyEntry } from "@shared/types";
import { api, useStore } from "../store";
import { formatDate, isExpiring, platformOf } from "../util";
import { ArmButton, CopyButton } from "./ui";

export function KeyField({ k }: { k: KeyEntry }) {
  const { busy, beginRedeem, setRedeemed, revealKeys, revealing, wanted, openWishlist, steamByKey } = useStore();
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
      const queue = revealing.indexOf(k.id); // 0 = being revealed now, >0 = waiting its turn
      field =
        queue >= 0 ? (
          <div className={`keyfield revealing${queue > 0 ? " waiting" : ""}`} aria-busy="true">
            <span className="spinner" aria-hidden />
            {queue === 0 ? "Revealing…" : `Waiting to reveal (${queue} ahead)`}
          </div>
        ) : (
          <ArmButton className="keyfield" disabled={busy} armedText="Click again to reveal. It can't be gifted afterwards" onFire={() => revealKeys([k.id]).then(() => undefined)}>
            {label}
          </ArmButton>
        );
    }
  }

  const meta = [];
  // its game is on your own Steam account (My Steam)
  const onSteam = steamByKey.get(k.id);
  if (onSteam?.on) {
    const { app, how } = onSteam.on;
    meta.push(
      <span
        key="st"
        className={onSteam.state === "redeemed" ? "redeemed-ok" : "steam-owned"}
        title={[
          `On your Steam account as ${app.name}`,
          how === "likely" && "Likely the same game (the titles differ only by edition words)",
          onSteam.state !== "redeemed" && "You have it on Steam, but not from this key (it was never revealed or was gifted)",
        ]
          .filter(Boolean)
          .join("\n")}
      >
        {onSteam.state === "redeemed" ? "✓ " : ""}
        {how === "likely" ? "~" : ""}
        {onSteam.state === "owned" && k.status === "unused" ? "Already on your Steam account: this key is a spare" : "On your Steam account"}
      </span>,
    );
  }
  // a spare key someone has on their Steam wishlist: who, and a jump to it there
  const wanters = wanted.get(k.id);
  if (wanters?.length) {
    meta.push(
      <span key="wl" className="wl-wanted">
        ♥ Wanted by{" "}
        {wanters.map((w, i) => (
          <span key={w.profile.steamId}>
            {i > 0 && ", "}
            <a
              title={[
                `#${w.game.rank} on ${w.profile.name}'s Steam wishlist: ${w.game.name}`,
                w.how === "likely" && "Likely the same game (the titles differ only by edition words)",
                k.notGiftable && k.status === "unused" && "Humble says this key can't be gifted: reveal it to give the key itself",
                "Click to see it on their wishlist",
              ]
                .filter(Boolean)
                .join("\n")}
              onClick={() => openWishlist(w.profile.steamId, k.name)}
            >
              {w.how === "likely" ? "~" : ""}
              {w.profile.name} #{w.game.rank}
            </a>
          </span>
        ))}
      </span>,
    );
  }
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

  // ---- the rest of what Humble says about this key ----
  if (k.status === "expired" && k.expiry) meta.push(<span key="ex">Expired {formatDate(k.expiry)}, never revealed</span>);
  if (k.giftState === "claimed") meta.push(<span key="gc">Gift: claimed</span>);
  else if (k.giftState === "gifted") meta.push(<span key="gs">Gift: sent{k.status === "gifted" ? ", waiting for or claimed by the recipient" : ""}</span>);
  const future = (d?: string | null) => !!d && Date.parse(d) > Date.now();
  if (future(k.availableFrom)) meta.push(<span key="af" className="soon">Can be revealed from {formatDate(k.availableFrom!)}</span>);
  if (k.preOrdered) meta.push(<span key="po">Pre-order{k.releaseDate ? ` · releases ${formatDate(k.releaseDate)}` : ""}</span>);
  else if (future(k.releaseDate)) meta.push(<span key="rd">Releases {formatDate(k.releaseDate!)}</span>);
  if (k.notGiftable && k.status === "unused") meta.push(<span key="ng" className="tag">can&apos;t be gifted</span>);
  if (k.cta && !links.some((l) => l.href === k.cta!.url))
    meta.push(
      <a key="cta" className="ext-out" title={k.cta.url} onClick={() => api.openExternal(k.cta!.url)}>
        {k.cta.label} ↗
      </a>,
    );
  // (it matters before you redeem; on every Steam key, so not after)
  if (k.disclaimer && !k.platformRedeemed && (k.status === "unused" || k.status === "revealed")) meta.push(<span key="dis" className="disclaimer">{k.disclaimer}</span>);
  const details = Object.entries(k.details || {});
  if (details.length)
    meta.push(
      <details key="det" className="key-details">
        <summary>Details</summary>
        <table>
          <tbody>
            {details.map(([name, v]) => (
              <tr key={name}>
                <th>{name.replace(/^(item|key)\./, "")}</th>
                <td>{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>,
    );

  return (
    <div>
      <div className="keyrow">{field}</div>
      {meta.length > 0 && <div className="keymeta">{meta}</div>}
    </div>
  );
}
