"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { GasPrice, SigningStargateClient } from "@cosmjs/stargate";
import type { OfflineSigner } from "@cosmjs/proto-signing";
import {
  CHAIN_ID,
  DENOM,
  RPC,
  availableWallets,
  connectWallet,
  disconnectWallet,
  type WalletKind,
} from "@/lib/wallet";

interface WalletState {
  address: string | null;
  name: string | null;
  kind: WalletKind | null;
  available: { kind: WalletKind; label: string }[];
  connecting: boolean;
  error: string | null;
  connect: (kind?: WalletKind) => Promise<void>;
  disconnect: () => void;
  /** Sign + broadcast a vote (yes/no) on a proposal. Returns tx hash. */
  castVote: (proposalId: string, choice: "yes" | "no") => Promise<string>;
  /** Sign + broadcast a comment on a proposal. Returns tx hash.
   *  Throws if the encoded memo would exceed the 256-byte chain soft-limit. */
  submitComment: (proposalId: string, body: string) => Promise<string>;
  /** Approximate max chars allowed in a comment body before the memo bumps
   *  the 256-byte soft limit. Useful for the input character counter. */
  commentBodyLimit: (proposalId: string) => number;
}

const Ctx = createContext<WalletState | null>(null);

const TREASURY =
  process.env.NEXT_PUBLIC_BWICK_TREASURY ??
  "bwick1x20cudlvuqqdlsdwgfwhdv9t32jzqkwzmsvyj8";
const VOTE_PREFIX = "bwick-vote:v1:";
const COMMENT_PREFIX = "bwick-comment:v1:";
const MEMO_LIMIT = 256;
const STORAGE_KEY = "frenzy-wallet-kind";

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [kind, setKind] = useState<WalletKind | null>(null);
  const [signer, setSigner] = useState<OfflineSigner | null>(null);
  const [available, setAvailable] = useState<{ kind: WalletKind; label: string }[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detect installed wallets on mount. Re-poll a few times because extensions
  // inject their providers slightly after page load.
  useEffect(() => {
    let n = 0;
    const t = setInterval(() => {
      setAvailable(availableWallets());
      n += 1;
      if (n >= 5) clearInterval(t);
    }, 400);
    setAvailable(availableWallets());
    return () => clearInterval(t);
  }, []);

  const connect = useCallback(async (k?: WalletKind) => {
    setError(null);
    setConnecting(true);
    try {
      const w = await connectWallet(k);
      setAddress(w.address);
      setName(w.name);
      setKind(w.kind);
      setSigner(w.signer);
      try {
        window.localStorage.setItem(STORAGE_KEY, w.kind);
      } catch { /* quota */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    const k = kind;
    setAddress(null);
    setName(null);
    setKind(null);
    setSigner(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
    if (k) void disconnectWallet(k);
  }, [kind]);

  // Auto-reconnect on mount if a prior kind is remembered and the provider
  // is still injected. enable() is a no-op for already-approved chains.
  useEffect(() => {
    if (address) return;
    let stored: WalletKind | null = null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === "bwick" || raw === "keplr") stored = raw;
    } catch { /* ignore */ }
    if (!stored) return;
    // Wait a tick so available providers populate first.
    const t = setTimeout(() => {
      const installed = availableWallets();
      if (installed.some((w) => w.kind === stored)) {
        void connect(stored!);
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to account switches in Keplr / BWICK Wallet.
  useEffect(() => {
    if (!kind) return;
    const handler = () => {
      void connect(kind);
    };
    window.addEventListener("keplr_keystorechange", handler);
    return () => window.removeEventListener("keplr_keystorechange", handler);
  }, [kind, connect]);

  const memoOverheadBytes = useCallback((proposalId: string) => {
    // "bwick-comment:v1:<proposalId>:" — everything except the base64 body.
    return COMMENT_PREFIX.length + proposalId.length + 1;
  }, []);

  const commentBodyLimit = useCallback(
    (proposalId: string) => {
      // Base64 expands by 4/3. We need: overhead + ceil(4 * body / 3) <= 256.
      // → body <= floor((256 - overhead) * 3 / 4)
      const available = MEMO_LIMIT - memoOverheadBytes(proposalId);
      if (available <= 0) return 0;
      return Math.floor((available * 3) / 4);
    },
    [memoOverheadBytes],
  );

  const submitComment = useCallback(
    async (proposalId: string, body: string): Promise<string> => {
      if (!signer || !address) {
        throw new Error("Connect a wallet first.");
      }
      const trimmed = body.trim();
      if (!trimmed) throw new Error("Comment is empty.");

      const encoded = (() => {
        if (typeof window === "undefined") {
          throw new Error("Browser-only operation.");
        }
        // btoa needs ASCII; coerce via TextEncoder so emoji/utf-8 survive.
        const bytes = new TextEncoder().encode(trimmed);
        let bin = "";
        for (const b of bytes) bin += String.fromCharCode(b);
        return window.btoa(bin);
      })();

      const memo = `${COMMENT_PREFIX}${proposalId}:${encoded}`;
      if (memo.length > MEMO_LIMIT) {
        throw new Error(
          `Comment too long (${memo.length}/${MEMO_LIMIT} bytes after encoding). Shorten it.`,
        );
      }

      const client = await SigningStargateClient.connectWithSigner(RPC, signer, {
        gasPrice: GasPrice.fromString(`0.025${DENOM}`),
      });
      try {
        const result = await client.sendTokens(
          address,
          TREASURY,
          [{ denom: DENOM, amount: "1" }],
          "auto",
          memo,
        );
        if (result.code !== 0) {
          throw new Error(`Comment failed (code ${result.code}): ${result.rawLog}`);
        }
        return result.transactionHash;
      } finally {
        client.disconnect();
      }
    },
    [signer, address],
  );

  const castVote = useCallback(
    async (proposalId: string, choice: "yes" | "no"): Promise<string> => {
      if (!signer || !address) {
        throw new Error("Connect a wallet first.");
      }
      const client = await SigningStargateClient.connectWithSigner(RPC, signer, {
        gasPrice: GasPrice.fromString(`0.025${DENOM}`),
      });
      try {
        const memo = `${VOTE_PREFIX}${proposalId}:${choice}`;
        const result = await client.sendTokens(
          address,
          TREASURY,
          [{ denom: DENOM, amount: "1" }],
          "auto",
          memo,
        );
        if (result.code !== 0) {
          throw new Error(`Vote failed (code ${result.code}): ${result.rawLog}`);
        }
        return result.transactionHash;
      } finally {
        client.disconnect();
      }
    },
    [signer, address],
  );

  const value = useMemo<WalletState>(
    () => ({
      address,
      name,
      kind,
      available,
      connecting,
      error,
      connect,
      disconnect,
      castVote,
      submitComment,
      commentBodyLimit,
    }),
    [
      address,
      name,
      kind,
      available,
      connecting,
      error,
      connect,
      disconnect,
      castVote,
      submitComment,
      commentBodyLimit,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
