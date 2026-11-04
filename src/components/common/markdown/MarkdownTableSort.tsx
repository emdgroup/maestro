import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useContext,
  createContext,
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
import { extractText } from "./markdown-sanitize";

export function compareValues(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}

interface TableSort {
  col: number | null;
  asc: boolean;
}
interface TableSortContextValue {
  sort: TableSort;
  onSort: (col: number) => void;
}
export const TableSortContext = createContext<TableSortContextValue | null>(null);

export function InteractiveTable({ children }: { children: ReactNode }) {
  const [sort, setSort] = useState<TableSort>({ col: null, asc: true });
  const tableRef = useRef<HTMLTableElement>(null);

  const onSort = useCallback((col: number) => {
    setSort((prev) => ({ col, asc: prev.col === col ? !prev.asc : true }));
  }, []);

  // A column's index is a DOM fact — `cellIndex` on sort, the cell's position in each row
  // when sorting. So the sorted marker is written to the DOM here rather than each header
  // discovering its own index and holding it in state, which needed a mount effect per
  // column just to render an arrow. `InteractiveTh` is now stateless and the arrow is CSS.
  useEffect(() => {
    const cells = tableRef.current?.querySelectorAll<HTMLTableCellElement>("thead th");
    cells?.forEach((cell, i) => {
      cell.dataset.sort = sort.col === i ? (sort.asc ? "asc" : "desc") : "none";
    });
  }, [sort]);

  return (
    <TableSortContext.Provider value={{ sort, onSort }}>
      <div className="overflow-x-auto my-3 rounded-lg border border-border">
        <table
          ref={tableRef}
          className="w-full border-collapse text-xs [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-muted/30"
        >
          {children}
        </table>
      </div>
    </TableSortContext.Provider>
  );
}

export function InteractiveTh({ children }: { children: ReactNode }) {
  const ctx = useContext(TableSortContext);
  return (
    <th
      data-sort="none"
      className="group border-b border-border px-3 py-2 text-left align-bottom text-[11px] font-medium uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors"
      onClick={(e) => ctx?.onSort(e.currentTarget.cellIndex)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <span className="text-[8px] transition-opacity opacity-0 after:content-['⇅'] group-hover:opacity-40 group-data-[sort=asc]:opacity-70 group-data-[sort=asc]:after:content-['▲'] group-data-[sort=desc]:opacity-70 group-data-[sort=desc]:after:content-['▼']" />
      </span>
    </th>
  );
}

export function InteractiveTbody({ children }: { children: ReactNode }) {
  const ctx = useContext(TableSortContext);
  if (!ctx || ctx.sort.col === null) return <tbody>{children}</tbody>;
  const { col, asc } = ctx.sort;
  const rows = Children.toArray(children);
  const sorted = [...rows].sort((a, b) => {
    const getText = (row: ReactNode) => {
      if (!isValidElement(row)) return "";
      const cells = Children.toArray(
        (row as ReactElement<{ children?: ReactNode }>).props.children,
      );
      return extractText(cells[col]);
    };
    const cmp = compareValues(getText(a), getText(b));
    return asc ? cmp : -cmp;
  });
  return <tbody>{sorted}</tbody>;
}
