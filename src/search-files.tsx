import {
  List,
  ActionPanel,
  Action,
  Icon,
  getPreferenceValues,
  showToast,
  Toast,
  Clipboard,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { execFile, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { Scope, EngineOpts } from "./engine";
import { IndexProfile, profiles,defaultIndex,BUILTIN_SCOPES as SCOPES } from "./catalog";
import {withSmartView,withAllView} from './search-ranking';
import {humanBytes,prettyPath} from './file-display';
import * as os from 'node:os';
const HOME=os.homedir();
const customPaths=(prefs:EngineOpts)=>(prefs.customSearchPaths||'').split(',').map(p=>p.trim()).filter(Boolean);

interface Prefs extends EngineOpts {
  resultLimit: string;
}

interface Meta {
  size?: number;
  mtime?: Date;
  dir?: boolean;
  gone?: boolean;
}

const IMG_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "heic",
  "tiff",
  "bmp",
  "ico",
]);
const isImage = (p: string) =>
  IMG_EXT.has(path.extname(p).slice(1).toLowerCase());

export default function Command() {
  const prefs = getPreferenceValues<Prefs>();
  const [scope, setScope] = useState<Scope>(()=>defaultIndex());
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [meta, setMeta] = useState<Record<string, Meta>>({});
  const [showDetail, setShowDetail] = useState(false);
  const [tick, setTick] = useState(0);
  const [savedIndexes, setSavedIndexes] = useState<IndexProfile[]>([]);
  const engineOpts: EngineOpts = SCOPES.includes(scope) ? prefs : {};
  useEffect(() => {
    try { setSavedIndexes(profiles()); }
    catch (e) { showToast({ style: Toast.Style.Failure, title: "Could not load saved indexes", message: e.message }); }
  }, [tick]);
  const procRef = useRef<ChildProcess[]>([]);
  const indexProcRef=useRef<ChildProcess|undefined>(undefined);
  useEffect(()=>()=>{indexProcRef.current?.kill('SIGTERM');},[]);
  const seq = useRef(0);
  const warnedScopes=useRef(new Set<string>());
  const limit = Math.max(
    10,
    parseInt(prefs.resultLimit || "300", 10) || 300,
  );

  useEffect(() => {
    const q = withSmartView(query.trim());
    if (indexing) {
      setResults([]);
      setSearching(false);
      return;
    }
    const timer = setTimeout(async () => {
      const mySeq = ++seq.current;
      setSearching(true);
      for (const p of procRef.current) p.kill("SIGKILL");
      try {
        const cli = path.join(HOME, ".local/bin/fe");
        if (!fs.existsSync(cli)) throw new Error("Install Find Everything with install.sh --local for indexed searches");
        if(scope==='custom'&&!customPaths(engineOpts).length)throw new Error('Set Custom Search Paths first');
        const roots = scope === "custom" ? customPaths(engineOpts).flatMap(p => ["--path", p]) : ["--index", scope];
        const settings = SCOPES.includes(scope) ? [engineOpts.includeHidden === false ? "--no-hidden" : "--hidden", engineOpts.includeIgnored ? "--include-ignored" : "--respect-ignore", ...(engineOpts.extraExcludes ? ["--exclude", engineOpts.extraExcludes] : [])] : [];
        const out = await new Promise<string>((resolve, reject) => {
          // Above the service's own 12-second search deadline: a cold first run after a
          // restart must answer or report its own error instead of a bare kill.
          const child = execFile(cli, ["search", "--json", "--snapshot", ...roots, ...settings, "-n", String(Math.min(1000, limit)), "--", q], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
          procRef.current = [child];
        });
        if (mySeq !== seq.current) return;
        const reply = JSON.parse(out);
        if(reply.properties?.length)setMeta(previous=>({...previous,...Object.fromEntries(reply.properties.filter((r:any)=>Number.isFinite(r.size)&&Number.isFinite(r.mtime)&&r.dir>=0).map((r:any)=>[r.path,{size:r.size,mtime:new Date(r.mtime),dir:r.dir===1}]))}));
        setResults(reply.paths);
        if (reply.complete===false && reply.warnings?.length && !warnedScopes.current.has(scope)) {warnedScopes.current.add(scope);showToast({ style: Toast.Style.Failure, title: "Snapshot coverage", message: "Some coverage is incomplete. Details are available in the app settings." });}
      } catch (e) {
        if (mySeq === seq.current) showToast({ style: Toast.Style.Failure, title: "Search failed", message: e.message });
      } finally { if (mySeq === seq.current) setSearching(false); }
    }, 120);
    return () => { clearTimeout(timer); seq.current++; for (const child of procRef.current) child.kill("SIGKILL"); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, scope, indexing, tick]);

  useEffect(() => {
    const pending = results.slice(0, 60).filter((p) => !(p in meta));
    if (!pending.length) return;
    let alive = true;
    Promise.all(
      pending.map(async (p): Promise<[string, Meta]> => {
        try {
          const s = await fs.promises.stat(p);
          return [
            p,
            { size: s.size, mtime: s.mtime, dir: s.isDirectory() },
          ];
        } catch {
          return [p, { gone: true }];
        }
      }),
    ).then((entries) => {
      if (alive)
        setMeta((m) => ({ ...m, ...Object.fromEntries(entries) }));
    });
    return () => {
      alive = false;
    };
  }, [results]);

  const refresh = () => {
    if(indexProcRef.current?.exitCode===null)return;
    if(scope==='custom'&&!customPaths(engineOpts).length){showToast({style:Toast.Style.Failure,title:'Set Custom Search Paths first'});return;}
    setIndexing(true);
    const cli=path.join(HOME,'.local/bin/fe');
    const roots=scope==='custom'?customPaths(engineOpts).flatMap(p=>['--path',p]):['--index',scope];
    const settings=SCOPES.includes(scope)?[engineOpts.includeHidden===false?'--no-hidden':'--hidden',engineOpts.includeIgnored?'--include-ignored':'--respect-ignore',...(engineOpts.extraExcludes?['--exclude',engineOpts.extraExcludes]:[])]:[];
    new Promise<void>((resolve,reject)=>{indexProcRef.current=execFile(cli,['index',...roots,...settings],{timeout:130000,maxBuffer:1024*1024},error=>error?reject(error):resolve());})
      .then(() => {
        setIndexing(false);
        setTick((t) => t + 1); // retrigger search effect
        showToast({ style: Toast.Style.Success, title: "Index rebuilt" });
      })
      .catch((e) => {
        setIndexing(false);
        showToast({
          style: Toast.Style.Failure,
          title: "Rebuild failed",
          message: String(e?.message || e),
        });
      });
  };

  const emptyTitle = indexing
    ? "Building index…"
      : searching
        ? "Searching…"
        : "No matches";

  const customEmpty =
    scope === "custom" && customPaths(prefs).length === 0;
  const emptyDesc = indexing
    ? `Building your personal index — first run only.`
    : customEmpty
      ? "Set 'Custom Search Paths' in the command preferences first."
      : "Search an indexed folder or project. ⌘R explicitly rebuilds it.";

  return (
    <List
      isLoading={indexing || searching}
      throttle
      filtering={false}
      isShowingDetail={showDetail}
      searchText={query}
      onSearchTextChange={setQuery}
      navigationTitle="Find Everything"
      searchBarPlaceholder="Documents & media first · ext:json for data · view:all for everything"
      searchBarAccessory={
        <List.Dropdown
          tooltip="Search scope"
          value={scope}
          onChange={(v) => setScope(v as Scope)}
          storeValue
        >
          <List.Dropdown.Item title="Home" value="home" icon={Icon.House} />
          <List.Dropdown.Item
            title="Downloads"
            value="downloads"
            icon={Icon.Download}
          />
          <List.Dropdown.Item
            title="Documents"
            value="documents"
            icon={Icon.Document}
          />
          <List.Dropdown.Item
            title="Applications"
            value="applications"
            icon={Icon.AppWindow}
          />
          <List.Dropdown.Item
            title="All (/)"
            value="all"
            icon={Icon.HardDrive}
          />
          <List.Dropdown.Item
            title="Custom paths"
            value="custom"
            icon={Icon.Folder}
          />
          {savedIndexes.map(index => <List.Dropdown.Item key={index.name} title={index.name} value={index.name} icon={Icon.Folder} />)}
        </List.Dropdown>
      }
    >
      <List.EmptyView title={emptyTitle} description={emptyDesc} />
      {results.map((p) => {
        const m = meta[p];
        const accessories: List.Item.Accessory[] = [];
        if (m?.dir) accessories.push({ tag: "Folder" });
        if (m?.size !== undefined && !m?.dir)
          accessories.push({ text: humanBytes(m.size) });
        if (m?.gone) accessories.push({ tag: { value: "gone", color: "#888" } });
        const shownPath = prettyPath(p);
        const detailMd =
          isImage(p) && !m?.dir && !m?.gone
            ? `![](file://${encodeURI(p).replace(/#/g, "%23")})\n\n`
            : `**${path.basename(p)}**\n\n`;
        return (
          <List.Item
            key={p}
            icon={{ fileIcon: p }}
            title={path.basename(p)}
            subtitle={{ value: shownPath, tooltip: p }}
            accessories={accessories}
            detail={
              <List.Item.Detail
                markdown={detailMd}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="Path"
                      text={p}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="Size"
                      text={
                        m?.dir
                          ? "—"
                          : m?.size !== undefined
                            ? humanBytes(m.size)
                            : ""
                      }
                    />
                    <List.Item.Detail.Metadata.Label
                      title="Modified"
                      text={m?.mtime ? m.mtime.toLocaleString() : ""}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="Type"
                      text={
                        m?.dir
                          ? "Folder"
                          : path.extname(p).slice(1).toUpperCase() || "File"
                      }
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <ActionPanel.Section>
                  <Action.Open title="Open" target={p} onOpen={()=>{
                    if(!query.trim())return;
                    execFile(path.join(HOME,'.local/bin/fe'),['learn','open',p,'--query',query,'--index',scope],{timeout:3000},error=>{if(error)void showToast({style:Toast.Style.Failure,title:'Local learning failed',message:error.message});});
                  }} />
                  <Action.ShowInFinder path={p} />
                  <Action
                    title="Open in Terminal"
                    icon={Icon.Terminal}
                    shortcut={{ modifiers: ["cmd"], key: "t" }}
                    onAction={() =>
                      execFile("open", [
                        "-a",
                        "Terminal",
                        m?.dir ? p : path.dirname(p),
                      ])
                    }
                  />
                </ActionPanel.Section>
                <ActionPanel.Section>
                  <Action.CopyToClipboard
                    title="Copy Path"
                    content={p}
                    shortcut={{ modifiers: ["cmd"], key: "c" }}
                  />
                  <Action.CopyToClipboard
                    title="Copy File Name"
                    content={path.basename(p)}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                  />
                  <Action
                    title="Copy File"
                    icon={Icon.Clipboard}
                    shortcut={{ modifiers: ["cmd", "opt"], key: "c" }}
                    onAction={() => Clipboard.copy({ file: p })}
                  />
                </ActionPanel.Section>
                <ActionPanel.Section>
                  <Action title="Show All Indexed Files" icon={Icon.Eye} onAction={()=>setQuery(withAllView(query))} />
                  <ActionPanel.Submenu title="Local Search Learning">
                    {['enable','disable','reset'].map(action=><Action key={action} title={action==='reset'?'Reset Learned Preferences':action==='enable'?'Enable Learning':'Disable Learning'} onAction={()=>{
                      execFile(path.join(HOME,'.local/bin/fe'),['learn',action],{timeout:3000},error=>{void showToast({style:error?Toast.Style.Failure:Toast.Style.Success,title:error?'Learning Update Failed':'Learning Updated',message:error?.message||action});setTick(t=>t+1);});
                    }} />)}
                  </ActionPanel.Submenu>
                  <Action
                    title="Toggle Preview"
                    icon={Icon.AppWindowSidebarRight}
                    shortcut={{ modifiers: ["cmd"], key: "d" }}
                    onAction={() => setShowDetail((v) => !v)}
                  />
                  <Action
                    title="Rebuild Index"
                    icon={Icon.ArrowClockwise}
                    shortcut={{ modifiers: ["cmd"], key: "r" }}
                    onAction={refresh}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
