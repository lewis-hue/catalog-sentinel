<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=realm.password && realm.registrationAllowed && !registrationDisabled??; section>
  <#if section = "header">
    Sign in
  <#elseif section = "form">
    <p class="kc-subtitle">Continue to your catalogue workspace.</p>

    <#if realm.password>
      <form id="kc-form-login" class="kc-form" onsubmit="login.disabled = true; return true;" action="${url.loginAction}" method="post">
        <#if !(usernameHidden!false)>
          <div class="kc-field-group">
            <label class="kc-label" for="username">
              <#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if>
            </label>
            <input tabindex="1" class="kc-field" id="username" name="username" value="${(login.username!'')}" type="text" autofocus autocomplete="username"
                   aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>" />
          </div>
        </#if>

        <div class="kc-field-group">
          <label class="kc-label" for="password">${msg("password")}</label>
          <input tabindex="2" class="kc-field" id="password" name="password" type="password" autocomplete="current-password"
                 aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>" />
        </div>

        <#if messagesPerField.existsError('username','password')>
          <div class="kc-field-error" aria-live="polite">
            ${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}
          </div>
        </#if>

        <#if realm.rememberMe && !(usernameHidden!false) || realm.resetPasswordAllowed>
          <div class="kc-form-options">
            <#if realm.rememberMe && !(usernameHidden!false)>
              <label class="kc-remember">
                <input tabindex="3" id="rememberMe" name="rememberMe" type="checkbox" <#if login.rememberMe??>checked</#if>/>
                ${msg("rememberMe")}
              </label>
            <#else>
              <span></span>
            </#if>
            <#if realm.resetPasswordAllowed>
              <a tabindex="4" class="kc-link" href="${url.loginResetCredentialsUrl}">${msg("doForgotPassword")}</a>
            </#if>
          </div>
        </#if>

        <div class="kc-form-buttons">
          <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
          <input tabindex="5" class="kc-btn" name="login" id="kc-login" type="submit" value="${msg("doLogIn")}"/>
        </div>
      </form>
    </#if>

    <#if realm.password && social.providers??>
      <div class="kc-social" id="kc-social-providers">
        <div class="kc-divider"><span>${msg("identity-provider-login-label")}</span></div>
        <ul class="kc-social-list">
          <#list social.providers as p>
            <li>
              <a id="social-${p.alias}" class="kc-btn ghost" type="button" href="${p.loginUrl}">
                <span>${p.displayName!}</span>
              </a>
            </li>
          </#list>
        </ul>
      </div>
    </#if>
  <#elseif section = "info">
    <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
      <div class="kc-info-line">
        ${msg("noAccount")} <a class="kc-link" tabindex="6" href="${url.registrationUrl}">${msg("doRegister")}</a>
      </div>
    </#if>
  </#if>
</@layout.registrationLayout>
