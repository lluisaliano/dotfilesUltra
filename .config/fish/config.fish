if status is-interactive
    # Commands to run in interactive sessions can go here
    atuin init fish | source
end

starship init fish | source

zoxide init fish | source

# Binding: doble ESC para insertar "sudo "
bind \e\e 'begin; set -l buf (commandline); commandline -r "sudo "$buf; end'

# pnpm
set -gx PNPM_HOME "/home/lluis/.local/share/pnpm"
if not string match -q -- $PNPM_HOME $PATH
    set -gx PATH "$PNPM_HOME" $PATH
end
# pnpm end
fastfetch

# uv
fish_add_path "/home/lluis/.local/bin"
