// Asked when you come back from a Redeem link: did you activate the key?
import { useEffect, useRef } from "react";
import { useStore } from "../store";

export function RedeemAsk() {
  const { redeemQuestion: q, answerRedeem } = useStore();
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!q) return;
    yes.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && answerRedeem(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [q, answerRedeem]);
  if (!q) return null;
  return (
    <div className="ask-backdrop hb">
      <div className="ask" role="dialog" aria-modal="true" aria-labelledby="redeemAskTitle">
        <h3 id="redeemAskTitle">Did you redeem it?</h3>
        <p>
          Did you redeem "{q.name}" on {q.platform}?
        </p>
        <div className="ask-actions">
          <button ref={yes} className="hb-btn" onClick={() => answerRedeem(true)}>
            Yes, it's redeemed
          </button>
          <button className="hb-btn ghost" onClick={() => answerRedeem(false)}>
            Not yet
          </button>
        </div>
      </div>
    </div>
  );
}
