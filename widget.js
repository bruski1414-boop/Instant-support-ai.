(function(){
  "use strict";
  var script=document.currentScript;
  if(!script)return;
  var slug=script.getAttribute("data-veyra-slug");
  var api=(script.getAttribute("data-veyra-api")||new URL(script.src).origin).replace(/\/+$/,"");
  if(!slug){console.error("Veyra widget: missing data-veyra-slug");return;}
  var root=document.createElement("div");
  root.id="veyra-support-widget";
  document.body.appendChild(root);
  var shadow=root.attachShadow({mode:"open"});
  var style=document.createElement("style");
  style.textContent=":host{all:initial;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:#f5f8fc}*{box-sizing:border-box}.launcher{position:fixed;right:22px;bottom:22px;z-index:2147483000;border:0;border-radius:999px;padding:14px 19px;background:#d6e9fb;color:#081421;font-weight:750;box-shadow:0 8px 32px #0004;cursor:pointer}.panel{position:fixed;right:22px;bottom:82px;width:min(370px,calc(100vw - 28px));height:min(540px,calc(100vh - 115px));z-index:2147483000;background:#0d1724;border:1px solid #34485f;border-radius:18px;box-shadow:0 18px 60px #0008;display:none;overflow:hidden}.panel.open{display:flex;flex-direction:column}.head{padding:16px;background:#15263a;border-bottom:1px solid #30445b}.head strong{display:block;font-size:15px}.head small{color:#a9bed4}.messages{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px}.bubble{max-width:88%;padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}.assistant{align-self:flex-start;background:#1a2b3f;color:#f4f8fc}.guest{align-self:flex-end;background:#24516b;color:white}.status{padding:6px 14px;color:#f0d7a5;font-size:11px}.form{display:flex;gap:8px;padding:12px;border-top:1px solid #30445b}.form input{flex:1;min-width:0;background:#07101a;border:1px solid #3a4c62;border-radius:9px;padding:11px;color:white;font-size:13px}.form button{border:0;border-radius:9px;padding:0 13px;background:#c5def8;color:#081421;font-weight:750}.fine{padding:0 14px 10px;color:#91a4b9;font-size:10px}.quick{margin-top:9px;border:1px solid #49617b;border-radius:8px;padding:7px 10px;background:#20364c;color:#eaf4ff;font-size:11px;font-weight:700;cursor:pointer}.booking{display:none;padding:12px;background:#101e2d;border-bottom:1px solid #30445b}.booking.open{display:block}.booking label{display:block;color:#a9bed4;font-size:10px;margin:0 0 4px}.booking input{width:100%;margin-bottom:8px;background:#07101a;border:1px solid #3a4c62;border-radius:8px;padding:8px;color:white;font-size:12px}.booking button{border:0;border-radius:8px;padding:9px 12px;background:#c5def8;color:#081421;font-weight:750;cursor:pointer}.booking button:disabled{opacity:.55}.booking-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.booking-grid .full{grid-column:1/-1}@media(max-width:480px){.launcher{right:14px;bottom:14px}.panel{right:14px;bottom:72px}}";
  shadow.appendChild(style);
  var panel=document.createElement("section");panel.className="panel";panel.setAttribute("aria-label","Veyra guest support");
  var head=document.createElement("div");head.className="head";
  var title=document.createElement("strong");title.textContent="Guest support";
  var sub=document.createElement("small");sub.textContent="Ask a question. A team member can help when needed.";
  var roomButton=document.createElement("button");roomButton.type="button";roomButton.className="quick";roomButton.textContent="Check room availability";
  head.append(title,sub,roomButton);
  var bookingForm=document.createElement("form");bookingForm.className="booking";
  var bookingGrid=document.createElement("div");bookingGrid.className="booking-grid";
  function bookingField(labelText,type,name,full){
    var wrap=document.createElement("div");if(full)wrap.className="full";
    var label=document.createElement("label");label.textContent=labelText;
    var field=document.createElement("input");field.type=type;field.name=name;field.required=true;
    if(type==="number"){field.min="1";field.max="20";field.step="1";field.value="2";}
    wrap.append(label,field);bookingGrid.appendChild(wrap);return field;
  }
  var checkInField=bookingField("Check-in","date","checkIn",false);
  var checkOutField=bookingField("Check-out","date","checkOut",false);
  var guestCountField=bookingField("Guests","number","guestCount",true);
  var availabilitySubmit=document.createElement("button");availabilitySubmit.type="submit";availabilitySubmit.textContent="Find available rooms";
  bookingForm.append(bookingGrid,availabilitySubmit);
  var messages=document.createElement("div");messages.className="messages";messages.setAttribute("aria-live","polite");
  var status=document.createElement("div");status.className="status";status.textContent="";
  var conversationId=null,conversationToken=null;
  var form=document.createElement("form");form.className="form";
  var input=document.createElement("input");input.type="text";input.maxLength=4000;input.placeholder="How can we help?";input.setAttribute("aria-label","Message the hotel");input.required=true;
  var send=document.createElement("button");send.type="submit";send.textContent="Send";
  form.append(input,send);
  var fine=document.createElement("div");fine.className="fine";fine.textContent="Please do not send payment details, passport numbers or sensitive personal information.";
  panel.append(head,bookingForm,messages,status,form,fine);
  var launcher=document.createElement("button");launcher.className="launcher";launcher.type="button";launcher.textContent="Chat with us";
  shadow.append(panel,launcher);
  function add(text,kind){var b=document.createElement("div");b.className="bubble "+kind;b.textContent=text;messages.appendChild(b);messages.scrollTop=messages.scrollHeight;}
  add("Hello. How can we help with your stay?", "assistant");
  launcher.addEventListener("click",function(){panel.classList.toggle("open");if(panel.classList.contains("open"))input.focus();});
  roomButton.addEventListener("click",function(){bookingForm.classList.toggle("open");if(bookingForm.classList.contains("open"))checkInField.focus();});
  bookingForm.addEventListener("submit",async function(e){
    e.preventDefault();availabilitySubmit.disabled=true;status.textContent="Checking the hotel's live inventory and rates…";
    try{
      var response=await fetch(api+"/api/public/"+encodeURIComponent(slug)+"/availability",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
        checkIn:checkInField.value,checkOut:checkOutField.value,guestCount:Number(guestCountField.value)
      })});
      var data=await response.json();if(!response.ok||data.verified!==true)throw new Error(data.error||"Live room availability could not be verified.");
      if(!Array.isArray(data.options)||!data.options.length){add("No matching rooms are currently available for those dates. Please contact the hotel team for help.","assistant");}
      else{
        data.options.forEach(function(option){
          var digits=new Intl.NumberFormat("en",{style:"currency",currency:option.currency}).resolvedOptions().maximumFractionDigits;
          var price=new Intl.NumberFormat(undefined,{style:"currency",currency:option.currency}).format(option.amountMinor/Math.pow(10,digits));
          var expiry=new Date(option.expiresAt).toLocaleTimeString();
          add(option.roomTypeName+" — "+price+" total for your stay. "+option.availableUnits+" room(s) currently available. Quote expires at "+expiry+". This is a quote, not a confirmed booking; please ask the hotel team to complete your reservation.","assistant");
        });
      }
      status.textContent="Live prices checked against the hotel's PMS. No reservation has been created.";
    }catch(err){add(err.message+" Please contact hotel staff if you need a booking now.","assistant");status.textContent="";}
    finally{availabilitySubmit.disabled=false;}
  });
  form.addEventListener("submit",async function(e){
    e.preventDefault();var message=input.value.trim();if(!message)return;
    add(message,"guest");input.value="";send.disabled=true;status.textContent="Preparing a response…";
    try{
      var response=await fetch(api+"/api/public/"+encodeURIComponent(slug)+"/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:message,conversationId:conversationId,conversationToken:conversationToken})});
      var data=await response.json();
      if(!response.ok)throw new Error(data.error||"The assistant is temporarily unavailable.");
      conversationId=data.conversationId||conversationId;conversationToken=data.conversationToken||conversationToken;
      add(data.reply||"Please contact the hotel team.","assistant");
      if(data.needsHuman){
        status.textContent=data.notificationDelivered?"The hotel notification endpoint accepted the handoff.":"Please contact hotel staff directly; automatic notification is not confirmed.";
      }else{status.textContent="";}
    }catch(err){add(err.message+" Please use the hotel's usual contact route if you need help now.","assistant");status.textContent="";}
    finally{send.disabled=false;input.focus();}
  });
})();