pub(super) fn drop_privileges(gid: u32, uid: u32) -> Result<(), String> {
    unsafe {
        if libc::setgroups(0, std::ptr::null()) != 0 {
            return Err(format!(
                "setgroups failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        if libc::setgid(gid) != 0 {
            return Err(format!(
                "setgid({gid}) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        if libc::setuid(uid) != 0 {
            return Err(format!(
                "setuid({uid}) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        #[cfg(target_os = "linux")]
        {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(format!(
                    "PR_SET_NO_NEW_PRIVS failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
    }
    Ok(())
}
