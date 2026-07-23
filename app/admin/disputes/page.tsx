'use client';

import { useReducer, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/lib/trpc-client';
import { DISPUTE_RESOLUTION_TEMPLATES } from '@/lib/services/dispute-service';
import { Gavel, Users, BarChart3, ArrowLeft, Loader2 } from 'lucide-react';

const STATUS_LABEL: Record<string, string> = {
  filed: 'Filed',
  evidence: 'Evidence',
  mediation: 'Mediation',
  community_vote: 'Community vote',
  resolved: 'Resolved',
  appealed: 'Appeal',
  closed: 'Closed',
};

export default function AdminDisputesPage() {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mediationNote, setMediationNote] = useState('');
  const [resolutionExtra, setResolutionExtra] = useState('');
  const [templateId, setTemplateId] = useState(DISPUTE_RESOLUTION_TEMPLATES[0]?.id ?? '');

  const { data: listData, isLoading: listLoading } = trpc.disputes.listDisputes.useQuery({});
  const { data: analytics, isLoading: analyticsLoading } = trpc.disputes.computeAnalytics.useQuery();

  const disputes = listData?.disputes ?? [];
  const selected = disputes.find((d) => d.id === selectedId) ?? disputes[0] ?? null;

  const voteTally = selected
    ? selected.communityVotes.reduce(
        (acc, v) => {
          acc[v.side as 'client' | 'creator'] += 1;
          return acc;
        },
        { client: 0, creator: 0 }
      )
    : { client: 0, creator: 0 };

  const utils = trpc.useUtils();

  function refresh() {
    utils.disputes.listDisputes.invalidate();
    utils.disputes.computeAnalytics.invalidate();
    bump();
  }

  const startMediationMut = trpc.disputes.startMediation.useMutation({
    onSuccess: () => refresh(),
  });
  const openVoteMut = trpc.disputes.openCommunityVote.useMutation({
    onSuccess: () => refresh(),
  });
  const resolveMut = trpc.disputes.resolveDispute.useMutation({
    onSuccess: () => refresh(),
  });
  const closeMut = trpc.disputes.closeDispute.useMutation({
    onSuccess: () => refresh(),
  });

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/admin" className="gap-1">
            <ArrowLeft className="h-4 w-4" /> Admin
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-bold mb-1 flex items-center gap-2">
          <Gavel className="h-7 w-7" /> Dispute mediation
        </h1>
        <p className="text-muted-foreground text-sm">
          Review cases, run mediation, optionally open advisory community votes, and resolve using
          templates.
        </p>
      </div>

      {analyticsLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading analytics…
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <BarChart3 className="h-4 w-4" /> Open
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{analytics?.totalOpen ?? 0}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Mediation</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{analytics?.inMediation ?? 0}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Users className="h-4 w-4" /> Community vote
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{analytics?.awaitingCommunity ?? 0}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Resolved (30d)</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{analytics?.resolvedLast30d ?? 0}</p>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Cases</CardTitle>
            <CardDescription>Select a dispute</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 max-h-[480px] overflow-y-auto">
            {listLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : disputes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No disputes found.</p>
            ) : (
              disputes.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setSelectedId(d.id)}
                  className={`w-full text-left rounded-lg border p-3 text-sm transition-colors ${
                    selected?.id === d.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-secondary/50'
                  }`}
                >
                  <div className="font-medium line-clamp-1">{d.title}</div>
                  <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {STATUS_LABEL[d.status] ?? d.status}
                    </Badge>
                    <span className="truncate">{d.id}</span>
                  </div>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Case detail</CardTitle>
            <CardDescription>
              {selected
                ? `${selected.filedByUserId} vs ${selected.counterpartyId ?? selected.creatorId}`
                : 'No disputes loaded'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!selected ? (
              <p className="text-sm text-muted-foreground">Nothing to show.</p>
            ) : (
              <>
                <div className="space-y-1 text-sm">
                  <p>
                    <span className="text-muted-foreground">Order ref:</span>{' '}
                    {selected.escrowId}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Category:</span> {selected.category}
                  </p>
                  <p className="pt-2">{selected.description}</p>
                  {selected.escrowAmountCents > 0 && (
                    <p className="text-amber-600 text-sm pt-2">
                      Escrow hold: ${(selected.escrowAmountCents / 100).toFixed(2)}
                    </p>
                  )}
                </div>

                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    Community votes (advisory)
                  </p>
                  <p className="text-sm">
                    Client: {voteTally.client} · Creator: {voteTally.creator}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="med-note">Mediation note</Label>
                  <Textarea
                    id="med-note"
                    value={mediationNote}
                    onChange={(e) => setMediationNote(e.target.value)}
                    rows={2}
                    placeholder="Optional note appended to the case"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={startMediationMut.isPending}
                    onClick={() => {
                      startMediationMut.mutate({
                        disputeId: selected.id,
                        note: mediationNote.trim() || undefined,
                      });
                      setMediationNote('');
                    }}
                  >
                    {startMediationMut.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    ) : null}
                    Start / continue mediation
                  </Button>
                </div>

                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={openVoteMut.isPending}
                  onClick={() => {
                    openVoteMut.mutate({ disputeId: selected.id });
                  }}
                >
                  {openVoteMut.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  ) : null}
                  Open community vote window
                </Button>

                <div className="space-y-2 border-t border-border pt-4">
                  <Label>Resolution template</Label>
                  <Select value={templateId} onValueChange={setTemplateId}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Template" />
                    </SelectTrigger>
                    <SelectContent>
                      {DISPUTE_RESOLUTION_TEMPLATES.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Textarea
                    value={resolutionExtra}
                    onChange={(e) => setResolutionExtra(e.target.value)}
                    rows={2}
                    placeholder="Optional extra context for the parties"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={resolveMut.isPending}
                      onClick={() => {
                        resolveMut.mutate({
                          disputeId: selected.id,
                          templateId,
                          extraSummary: resolutionExtra.trim() || undefined,
                        });
                        setResolutionExtra('');
                      }}
                    >
                      {resolveMut.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-1" />
                      ) : null}
                      Apply template & resolve
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={closeMut.isPending}
                      onClick={() => {
                        closeMut.mutate({ disputeId: selected.id });
                      }}
                    >
                      {closeMut.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-1" />
                      ) : null}
                      Close case
                    </Button>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Timeline</p>
                  <ul className="text-xs space-y-1 max-h-40 overflow-y-auto border rounded-md p-2 bg-muted/30">
                    {selected.timeline.map((t) => (
                      <li key={t.id}>
                        <span className="text-muted-foreground">
                          {new Date(t.at).toLocaleString()}
                        </span>{' '}
                        — {t.message}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
