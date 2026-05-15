const REST_ENDPOINT =
  process.env.NEXT_PUBLIC_BWICK_REST ??
  process.env.NEXT_PUBLIC_REST_ENDPOINT ??
  "http://167.99.147.85/rest";

export const BWICK_TREASURY =
  process.env.NEXT_PUBLIC_BWICK_TREASURY ??
  "bwick1x20cudlvuqqdlsdwgfwhdv9t32jzqkwzmsvyj8";

const PROP_PREFIX = "bwick-prop:v1:";
const VOTE_PREFIX = "bwick-vote:v1:";
const COMMENT_PREFIX = "bwick-comment:v1:";

export interface CommunityProposal {
  id: string;
  proposer: string;
  title: string;
  description: string;
  height: number;
  timestamp: number;
}

export interface CommunityVote {
  voter: string;
  vote: "yes" | "no";
  txHash: string;
  height: number;
  timestamp: number;
}

export interface CommunityComment {
  author: string;
  body: string;
  txHash: string;
  height: number;
  timestamp: number;
}

export interface ProposalWithTally extends CommunityProposal {
  yesCount: number;
  noCount: number;
  yourVote: "yes" | "no" | null;
}

export interface ProposalWithVotes {
  proposal: ProposalWithTally;
  votes: CommunityVote[];
  comments: CommunityComment[];
}

interface CosmosTxResponse {
  txhash: string;
  height: string;
  timestamp: string;
  code: number;
  tx?: {
    body?: {
      memo?: string;
      messages?: Array<Record<string, unknown> & { "@type": string }>;
    };
  };
}

interface ListResponse {
  tx_responses?: CosmosTxResponse[];
}

async function fetchTreasuryTxs(limit = 200): Promise<CosmosTxResponse[]> {
  const url = new URL(`${REST_ENDPOINT.replace(/\/$/, "")}/cosmos/tx/v1beta1/txs`);
  url.searchParams.set("query", `transfer.recipient='${BWICK_TREASURY}'`);
  url.searchParams.set("order_by", "ORDER_BY_DESC");
  url.searchParams.set("pagination.limit", String(limit));

  const res = await fetch(url.toString(), { next: { revalidate: 10 } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Treasury tx fetch failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as ListResponse;
  return (json.tx_responses ?? []).filter((tx) => tx.code === 0);
}

function decodePayload(payload: string): unknown {
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

function senderFromTx(tx: CosmosTxResponse): string {
  const msg = tx.tx?.body?.messages?.[0];
  return String((msg as Record<string, unknown> | undefined)?.from_address ?? "");
}

function parseProposalFromTx(tx: CosmosTxResponse): CommunityProposal | null {
  const memo = tx.tx?.body?.memo ?? "";
  if (!memo.startsWith(PROP_PREFIX)) return null;

  try {
    const body = decodePayload(memo.slice(PROP_PREFIX.length)) as {
      title?: unknown;
      description?: unknown;
    };

    if (typeof body.title !== "string" || typeof body.description !== "string") {
      return null;
    }

    return {
      id: tx.txhash,
      proposer: senderFromTx(tx),
      title: body.title,
      description: body.description,
      height: Number(tx.height),
      timestamp: new Date(tx.timestamp).getTime(),
    };
  } catch {
    return null;
  }
}

function parseCommentFromTx(
  tx: CosmosTxResponse,
): (CommunityComment & { proposalId: string }) | null {
  const memo = tx.tx?.body?.memo ?? "";
  if (!memo.startsWith(COMMENT_PREFIX)) return null;

  const rest = memo.slice(COMMENT_PREFIX.length);
  const firstColon = rest.indexOf(":");
  if (firstColon < 0) return null;

  const proposalId = rest.slice(0, firstColon);
  const encoded = rest.slice(firstColon + 1);

  let body: string;
  try {
    body = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }
  if (!body) return null;

  const author = senderFromTx(tx);
  if (!author) return null;

  return {
    author,
    body,
    txHash: tx.txhash,
    height: Number(tx.height),
    timestamp: new Date(tx.timestamp).getTime(),
    proposalId,
  };
}

function parseVoteFromTx(
  tx: CosmosTxResponse,
): (CommunityVote & { proposalId: string }) | null {
  const memo = tx.tx?.body?.memo ?? "";
  if (!memo.startsWith(VOTE_PREFIX)) return null;

  const rest = memo.slice(VOTE_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return null;

  const proposalId = rest.slice(0, lastColon);
  const choice = rest.slice(lastColon + 1);
  if (choice !== "yes" && choice !== "no") return null;

  const voter = senderFromTx(tx);
  if (!voter) return null;

  return {
    voter,
    vote: choice,
    txHash: tx.txhash,
    height: Number(tx.height),
    timestamp: new Date(tx.timestamp).getTime(),
    proposalId,
  };
}

export async function listProposalsWithTally(
  viewer?: string,
): Promise<ProposalWithTally[]> {
  const txs = await fetchTreasuryTxs(200);
  const proposals: CommunityProposal[] = [];
  const votesByProposal = new Map<string, Map<string, CommunityVote>>();

  for (const tx of [...txs].reverse()) {
    const proposal = parseProposalFromTx(tx);
    if (proposal) {
      proposals.push(proposal);
      continue;
    }

    const vote = parseVoteFromTx(tx);
    if (!vote) continue;

    let votesByVoter = votesByProposal.get(vote.proposalId);
    if (!votesByVoter) {
      votesByVoter = new Map();
      votesByProposal.set(vote.proposalId, votesByVoter);
    }

    if (!votesByVoter.has(vote.voter)) {
      votesByVoter.set(vote.voter, {
        voter: vote.voter,
        vote: vote.vote,
        txHash: vote.txHash,
        height: vote.height,
        timestamp: vote.timestamp,
      });
    }
  }

  proposals.sort((a, b) => b.height - a.height);

  return proposals.map((proposal) => {
    const votesByVoter = votesByProposal.get(proposal.id);
    let yesCount = 0;
    let noCount = 0;
    let yourVote: ProposalWithTally["yourVote"] = null;

    if (votesByVoter) {
      for (const vote of votesByVoter.values()) {
        if (vote.vote === "yes") yesCount += 1;
        else noCount += 1;
        if (viewer && vote.voter === viewer) yourVote = vote.vote;
      }
    }

    return { ...proposal, yesCount, noCount, yourVote };
  });
}

export type ActivityKind = "proposal" | "vote";

export interface ActivityItem {
  kind: ActivityKind;
  txHash: string;
  actor: string;
  height: number;
  timestamp: number;
  /** For votes: the proposal ID we're voting on. For proposals: the txhash. */
  proposalId: string;
  /** Title of the related proposal, or for fresh proposals the title itself. */
  proposalTitle: string;
  /** Only set on votes. */
  vote?: "yes" | "no";
}

/** Latest treasury activity flattened into proposal-create + vote events,
 *  newest first. Looks up titles inline so the ticker can show context. */
export async function listRecentActivity(limit = 25): Promise<ActivityItem[]> {
  const txs = await fetchTreasuryTxs(200);
  const titlesById = new Map<string, string>();

  // First pass: collect proposals so we can attach titles to votes.
  for (const tx of [...txs].reverse()) {
    const proposal = parseProposalFromTx(tx);
    if (proposal) titlesById.set(proposal.id, proposal.title);
  }

  const out: ActivityItem[] = [];
  for (const tx of txs) {
    const proposal = parseProposalFromTx(tx);
    if (proposal) {
      out.push({
        kind: "proposal",
        txHash: tx.txhash,
        actor: proposal.proposer,
        height: proposal.height,
        timestamp: proposal.timestamp,
        proposalId: proposal.id,
        proposalTitle: proposal.title,
      });
      if (out.length >= limit) break;
      continue;
    }
    const vote = parseVoteFromTx(tx);
    if (vote) {
      out.push({
        kind: "vote",
        txHash: vote.txHash,
        actor: vote.voter,
        height: vote.height,
        timestamp: vote.timestamp,
        proposalId: vote.proposalId,
        proposalTitle: titlesById.get(vote.proposalId) ?? "unknown proposal",
        vote: vote.vote,
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export async function getProposalWithVotes(
  id: string,
  viewer?: string,
): Promise<ProposalWithVotes | null> {
  const txs = await fetchTreasuryTxs(300);
  const proposalsById = new Map<string, CommunityProposal>();
  const votesByProposal = new Map<string, Map<string, CommunityVote>>();
  const commentsByProposal = new Map<string, CommunityComment[]>();

  for (const tx of [...txs].reverse()) {
    const proposal = parseProposalFromTx(tx);
    if (proposal) {
      proposalsById.set(proposal.id, proposal);
      continue;
    }

    const vote = parseVoteFromTx(tx);
    if (vote) {
      let votesByVoter = votesByProposal.get(vote.proposalId);
      if (!votesByVoter) {
        votesByVoter = new Map();
        votesByProposal.set(vote.proposalId, votesByVoter);
      }

      if (!votesByVoter.has(vote.voter)) {
        votesByVoter.set(vote.voter, {
          voter: vote.voter,
          vote: vote.vote,
          txHash: vote.txHash,
          height: vote.height,
          timestamp: vote.timestamp,
        });
      }
      continue;
    }

    const comment = parseCommentFromTx(tx);
    if (comment) {
      const list = commentsByProposal.get(comment.proposalId) ?? [];
      list.push({
        author: comment.author,
        body: comment.body,
        txHash: comment.txHash,
        height: comment.height,
        timestamp: comment.timestamp,
      });
      commentsByProposal.set(comment.proposalId, list);
    }
  }

  const proposal = proposalsById.get(id);
  if (!proposal) return null;

  const votesByVoter = votesByProposal.get(id);
  const votes = votesByVoter ? [...votesByVoter.values()].sort((a, b) => b.timestamp - a.timestamp) : [];
  const comments = (commentsByProposal.get(id) ?? []).sort((a, b) => b.timestamp - a.timestamp);

  let yesCount = 0;
  let noCount = 0;
  let yourVote: ProposalWithTally["yourVote"] = null;

  for (const vote of votes) {
    if (vote.vote === "yes") yesCount += 1;
    else noCount += 1;
    if (viewer && vote.voter === viewer) yourVote = vote.vote;
  }

  return {
    proposal: {
      ...proposal,
      yesCount,
      noCount,
      yourVote,
    },
    votes,
    comments,
  };
}
