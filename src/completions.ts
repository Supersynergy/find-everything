export function completions(shell: string): string {
  const commands = "search favorites index indexes status watch prepare combine properties enrich repair-media semantic query-help open reveal preview completions serve mcp help";
  if (shell === "bash") return `_fe() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
    --index|--scope) COMPREPLY=( $(compgen -W "$(fe indexes --names 2>/dev/null)" -- "$cur") ) ;;
    --path) COMPREPLY=( $(compgen -d -- "$cur") ) ;;
    --preset) COMPREPLY=( $(compgen -W "project folder" -- "$cur") ) ;;
    --kind) COMPREPLY=( $(compgen -W "audio video image media" -- "$cur") ) ;;
    completions) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ) ;;
    *) COMPREPLY=( $(compgen -W "${commands} --index --path --name --preset --exclude --max-age --json --null --fresh --snapshot --socket --kind --max-files --seconds --idle-seconds --offset --query --hidden --include-ignored --replace --limit --port --help" -- "$cur") $(compgen -f -- "$cur") ) ;;
  esac
}
complete -o filenames -F _fe fe
`;
  if (shell === "zsh") return `#compdef fe
_fe() {
  local -a indexes
  indexes=(\${(f)"$(fe indexes --names 2>/dev/null)"})
  _arguments -s \\
    '1:command:(${commands})' \\
    '*--index[index name]:index:($indexes)' '*--scope[scope]:scope:($indexes)' \\
    '*--path[folder]:folder:_directories' '--name[saved index name]:name:' \\
    '--preset[defaults]:preset:(project folder)' '--limit[result limit]:count:' \\
    '*--exclude[exclude glob]:glob:' '--max-age[refresh age in minutes]:minutes:' \\
    '--json[JSON output]' '--null[NUL separated paths]' '--fresh[refresh before search]' \\
    '--hidden[include dotfiles]' '--no-hidden[exclude dotfiles]' '--include-ignored[include ignored files]' \\
    '--respect-ignore[honor ignore rules]' '--replace[update saved profile]' \\
    '--port[local API port]:port:' '--interval[watch debounce seconds]:seconds:' \\
    '--socket[private Unix socket]:socket:_files' '--snapshot[use existing snapshot]' '--live[automatic incremental updates]' \\
    '--kind[media kind]:kind:(audio video image media)' '--max-files[probe budget]:count:' \\
    '--seconds[enrichment time budget]:seconds:' '--idle-seconds[service idle timeout]:seconds:' \\
    '--offset[browse or filtered page offset]:offset:' '--query[sound analysis candidate query]:query:' \\
    '--help[help]' '--version[version]' '*:file:_files'
}
compdef _fe fe
`;
  if (shell === "fish") return `complete -c fe -f
complete -c fe -n '__fish_use_subcommand' -a '${commands}'
complete -c fe -l index -l scope -r -a '(fe indexes --names 2>/dev/null)'
complete -c fe -l path -r -a '(__fish_complete_directories)'
complete -c fe -l preset -r -a 'project folder'
complete -c fe -l kind -r -a 'audio video image media'
complete -c fe -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish'
complete -c fe -l json -l null -l fresh -l hidden -l no-hidden -l include-ignored -l respect-ignore -l replace -l help -l version
complete -c fe -l snapshot
complete -c fe -l name -l exclude -l max-age -l limit -l port -l interval -l socket -l max-files -l seconds -l idle-seconds -l offset -l query -r
`;
  throw new Error("Shell must be bash, zsh or fish");
}
