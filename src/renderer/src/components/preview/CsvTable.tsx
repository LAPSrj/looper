import { useMemo } from 'react';
import { parseDelimited, sniffDelimiter } from '@shared/preview';
import { SheetTable } from './SheetTable';

/** A CSV or TSV file as a table, its first row the columns' names. */
export default function CsvTable({ text, name }: { text: string; name: string }) {
  const rows = useMemo(() => parseDelimited(text, sniffDelimiter(name, text)), [text, name]);
  return <SheetTable rows={rows} header name={name} />;
}
