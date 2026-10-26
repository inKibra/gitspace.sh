import { Recording01 } from '@untitledui/icons';

/** A capture named in a message (`capture://<id>`) as a chip: the recording icon, its name and, muted, what else
 * identifies it. */
export function CaptureChip({ name, detail }: { name: string; detail: string | null }) {
  return <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 py-1 text-caption">
    <Recording01 className="shrink-0" width={13} height={13} />
    <strong className="min-w-0 truncate font-medium">{name}</strong>
    {detail ? <span className="min-w-0 truncate text-muted-foreground">· {detail}</span> : null}
  </span>;
}
