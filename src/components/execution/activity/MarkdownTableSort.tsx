import {
  useState,
  useRef,
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
  getNextHeaderIndex: () => number;
}
export const TableSortContext = createContext<TableSortContextValue | null>(null);

export function InteractiveTable({ children }: { children: ReactNode }) {
  const [sort, setSort] = useState<TableSort>({ col: null, asc: true });
  const headerCountRef = useRef(0);
  headerCountRef.current = 0;
  const getNextHeaderIndex = useCallback(() => headerCountRef.current++, []);
  const onSort = useCallback((col: number) => {
    setSort((prev) => ({ col, asc: prev.col === col ? !prev.asc : true }));
  }, []);
  return (
    <TableSortContext.Provider value={{ sort, onSort, getNextHeaderIndex }}>
      <div className="overflow-x-auto my-2">
        <table className="w-full border-collapse text-xs">{children}</table>
      </div>
    </TableSortContext.Provider>
  );
}

export function InteractiveTh({ children }: { children: ReactNode }) {
  const ctx = useContext(TableSortContext);
  const colRef = useRef(-1);
  if (ctx && colRef.current === -1) {
    colRef.current = ctx.getNextHeaderIndex();
  }
  const col = colRef.current;
  const isSorted = ctx?.sort.col === col;
  return (
    <th
      className="border border-border px-2.5 py-1.5 text-left font-semibold text-muted-foreground cursor-pointer select-none hover:bg-muted/80 transition-colors"
      onClick={() => ctx?.onSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <span className="text-[8px] opacity-40">{isSorted ? (ctx.sort.asc ? "▲" : "▼") : "⇅"}</span>
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
