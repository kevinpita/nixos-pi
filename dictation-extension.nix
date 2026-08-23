{ username, ... }:
{
  home-manager.users.${username}.home.file.".pi/agent/extensions/dictation.ts".source =
    ./extensions/dictation.ts;
}
