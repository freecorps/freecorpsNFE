import { useStaticSearch } from "fumadocs-core/search/client";
import {
  SearchDialog as Dialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";

// Static search: the index is a file built with the pages (/docs/search.json),
// fetched from the same origin on first use (connect-src 'self').
export function SearchDialog(props: SharedProps) {
  const search = useStaticSearch({ from: "/docs/search.json" });
  return (
    <Dialog {...search} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList />
      </SearchDialogContent>
    </Dialog>
  );
}
