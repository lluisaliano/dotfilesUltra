if status is-interactive
    # Commands to run in interactive sessions can go here
    atuin init fish | source
end

starship init fish | source

zoxide init fish | source

# Binding: doble ESC para insertar "sudo "
bind \e\e 'begin; set -l buf (commandline); commandline -r "sudo "$buf; end'
