import { ScrollArea } from "@/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/table";
import type { CanvasSurface } from "../../types";

interface Column {
  key: string;
  label: string;
  width?: string;
}

interface Props {
  columns?: Column[];
  rows?: string;
  surface: CanvasSurface;
  [key: string]: unknown;
}

export function CanvasDataTable({ columns = [], rows, surface }: Props) {
  const rowData = rows ? ((surface.data[rows] as unknown[][] | undefined) ?? []) : [];

  return (
    <ScrollArea className="max-h-80 rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.key} style={col.width ? { width: col.width } : undefined}>
                {col.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rowData.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-muted-foreground">
                No data
              </TableCell>
            </TableRow>
          ) : (
            rowData.map((row, i) => (
              <TableRow key={i}>
                {columns.map((col, j) => (
                  <TableCell key={col.key}>{String(row[j] ?? "")}</TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}
