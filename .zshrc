# ZSH Config

# path
#export PATH="$HOME/.local/bin:$PATH"
export PATH="$HOME/.cargo/bin:$PATH"
#export PATH="$HOME/.config/rofi/bin:$PATH"
#export PATH="/opt/anaconda/bin:$PATH"  # commented out by conda initialize
export PATH=$HOME/.config/rofi/scripts:$PATH

# env
export VISUAL=nvim;
export EDITOR=nvim;
export SUDO_PROMPT="Password  :"
export QT_QPA_PLATFORMTHEME="qt5ct"


# Keep 1000 lines of history within the shell and save it to ~/.histfile:
HISTFILE=~/.histfile
HISTSIZE=1000
SAVEHIST=1000
bindkey -e
# End of lines configured by zsh-newuser-install
# The following lines were added by compinstall
zstyle :compinstall filename '/home/lluis/.zshrc'

autoload -Uz compinit
compinit
# End of lines added by compinstall

bindkey "^[[H" beginning-of-line
bindkey "^[[F" end-of-line
bindkey "^[[3~" delete-char
bindkey "^[[1;3C" forward-word
bindkey "^[[1;3D" backward-word 

# Keep 1000 lines of history within the shell and save it to ~/.zsh_history:

# Set up the prompt
eval "$(starship init zsh)"

zstyle ':completion:*' auto-description 'specify: %d'
zstyle ':completion:*' completer _expand _complete _correct _approximate
zstyle ':completion:*' format 'Completing %d'
zstyle ':completion:*' group-name ''
zstyle ':completion:*' menu select=2
eval "$(dircolors -b)"
zstyle ':completion:*:default' list-colors ${(s.:.)LS_COLORS}
zstyle ':completion:*' list-colors ''
zstyle ':completion:*' list-prompt %SAt %p: Hit TAB for more, or the character to insert%s
zstyle ':completion:*' matcher-list '' 'm:{a-z}={A-Z}' 'm:{a-zA-Z}={A-Za-z}' 'r:|[._-]=* r:|=* l:|=*'
zstyle ':completion:*' menu select=long
zstyle ':completion:*' select-prompt %SScrolling active: current selection at %p%s
zstyle ':completion:*' use-compctl false
zstyle ':completion:*' verbose true

zstyle ':completion:*:*:kill:*:processes' list-colors '=(#b) #([0-9]#)*=0=01;31'
zstyle ':completion:*:kill:*' command 'ps -u $USER -o pid,%cpu,tty,cputime,cmd'

alias batteryInfo='upower -i /org/freedesktop/UPower/devices/battery_BAT0'
alias checkCircular='pacman -Qqd | pacman -Rsu --print -'
alias removeOrphan='pacman -Qdtq | sudo pacman -Rns -'
alias battery='bat-asus-battery'
alias grep='grep --color=auto'
alias windows='sudo ntfs-3g /dev/nvme0n1p3 /mnt/windows'
alias uwindows='sudo umount /mnt/windows'
alias cat='bat'
alias ls='lsd --color=auto'
alias tree='lsd --tree'
alias clock='tty-clock -c -C 3 -D'
alias cmatrix='cmatrix -C yellow'
alias pipes='pipes.sh -p 5 -r 0'
alias music='spt'
alias xephyr='Xephyr -br -ac -noreset -screen 1280x720 :1 &'
alias vim='nvim'
alias icat='kitty +kitten icat'
alias dotfiles='/usr/bin/git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME'
alias luxorpi='clear && ssh -l dietpi pi.hole'
alias minipc='clear && ssh -l lluis 192.168.1.44'
alias image='eog'
# Faster terminal by not loading anaconda if it is not used
alias anaconda='source  ~/.conda.zshrc'
# VPS
alias luxorvps='ssh -i .ssh/ssh-key-2024-06-19.key lluis@143.47.48.228'

# Plugins
source /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
source /usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh
source /usr/share/zsh/plugins/zsh-sudo/sudo-plugin.zsh


[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# Set 'man' colors
function man() {
    env \
    LESS_TERMCAP_mb=$'\e[01;31m' \
    LESS_TERMCAP_md=$'\e[01;31m' \
    LESS_TERMCAP_me=$'\e[0m' \
    LESS_TERMCAP_se=$'\e[0m' \
    LESS_TERMCAP_so=$'\e[01;44;33m' \
    LESS_TERMCAP_ue=$'\e[0m' \
    LESS_TERMCAP_us=$'\e[01;32m' \
    man "$@"
}

# fzf improvement
function fzf-lovely(){

        if [ "$1" = "h" ]; then
                fzf -m --reverse --preview-window down:20 --preview '[[ $(fil>
                        echo {} is a binary file ||
                         (bat --style=numbers --color=always {} ||
                          highlight -O ansi -l {} ||
                          coderay {} ||
                          rougify {} ||
                          cat {}) 2> /dev/null | head -500'

        else
                fzf -m --preview '[[ $(file --mime {}) =~ binary ]] &&
                                 echo {} is a binary file ||
                                 (bat --style=numbers --color=always {} ||
                                  highlight -O ansi -l {} ||
                                  coderay {} ||
                                  rougify {} ||
                                  cat {}) 2> /dev/null | head -500'
        fi
}

function rmk(){
        scrub -p dod $1
        shred -zun 10 -v $1
}

typeset -A ZSH_HIGHLIGHT_STYLES
ZSH_HIGHLIGHT_STYLES[unknown-token]='fg=red'

eval "$(zoxide init zsh)"

# Node package Manager
eval "$(fnm env --use-on-cd)"

# Fetch (Use Nitch)
#nitch
#neofetch 
#pfetch


# pnpm
export PNPM_HOME="/home/lluis/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end

PATH=~/.console-ninja/.bin:$PATH
